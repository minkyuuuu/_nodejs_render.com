const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
// 클라우드 동기화를 위한 JSON 설정
app.use(express.json({ limit: '10mb' })); 
app.use(express.static('public'));

// API 키 확인용 로그
console.log("API Key Loaded:", process.env.YOUTUBE_API_KEY ? "YES" : "NO");

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// [클라우드 저장소] 서버 메모리에 데이터를 임시 저장할 변수
let playlistCloudData = null;

/**
 * 클라우드 저장 (업로드)
 */
app.post('/api/sync-upload', (req, res) => {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: '저장할 데이터가 없습니다.' });
    playlistCloudData = data;
    res.json({ message: '서버에 재생목록이 안전하게 저장되었습니다.' });
});

/**
 * 클라우드 불러오기 (다운로드)
 */
app.get('/api/sync-download', (req, res) => {
    if (!playlistCloudData) {
        return res.status(404).json({ error: '서버에 저장된 데이터가 없습니다.' });
    }
    res.json({ data: playlistCloudData });
});

// 공통 함수: ID로 채널 상세 정보 조회 (검색 UI 통합을 위해 추가)
async function getChannelDetails(channelId) {
    const response = await youtube.channels.list({
        part: 'snippet,statistics,contentDetails',
        id: channelId,
    });
    if (!response.data.items || !response.data.items.length) return null;
    const channel = response.data.items[0];
    return {
        channelId: channel.id,
        handle: channel.snippet.customUrl,
        title: channel.snippet.title,
        thumbnail: channel.snippet.thumbnails.default.url,
        description: channel.snippet.description,
        videoCount: parseInt(channel.statistics.videoCount) || 0,
    };
}

// [수정됨] 유튜버 검색 및 핸들/ID 처리 (동영상 앱과 동일한 로직 적용)
app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    try {
        let targetChannelId = null;

        // 1. ID (UC...) 확인
        if (handle.startsWith('UC') && handle.length > 20) {
            targetChannelId = handle;
        } 
        // 2. URL 확인
        else if (handle.includes('youtube.com/channel/')) {
            const match = handle.match(/channel\/(UC[a-zA-Z0-9_-]{22})/);
            if (match) targetChannelId = match[1];
        }

        // ID가 바로 식별되면 조회 후 반환
        if (targetChannelId) {
            const details = await getChannelDetails(targetChannelId);
            if (details) return res.json(details);
            return res.status(404).json({ error: '해당 ID의 채널을 찾을 수 없습니다.' });
        }

        // 3. 핸들(@) 확인
        if (handle.startsWith('@')) {
            try {
                const handleResponse = await youtube.channels.list({ part: 'id', forHandle: handle });
                if (handleResponse.data.items && handleResponse.data.items.length > 0) {
                    targetChannelId = handleResponse.data.items[0].id;
                }
            } catch (err) { console.log("Handle lookup failed:", err.message); }
        }

        // 4. 검색 수행 (ID/핸들 아님)
        if (!targetChannelId) {
            // 검색 결과 10개까지 조회
            const search = await youtube.search.list({ 
                part: 'snippet', 
                type: 'channel', 
                q: handle, 
                maxResults: 10 
            });
            
            if (!search.data.items || !search.data.items.length) {
                return res.status(404).json({ error: '검색된 채널이 없습니다.' });
            }
            
            // 검색 결과가 1개면 바로 진행, 여러 개면 목록 반환
            if (search.data.items.length === 1) {
                targetChannelId = search.data.items[0].id.channelId;
            } else {
                const candidates = search.data.items.map(item => ({
                    channelId: item.id.channelId,
                    title: item.snippet.title,
                    description: item.snippet.description,
                    thumbnail: item.snippet.thumbnails.default.url
                }));
                return res.json({ multiple: true, candidates });
            }
        }

        // 5. 최종 상세 조회
        const details = await getChannelDetails(targetChannelId);
        if (!details) return res.status(404).json({ error: '채널 상세 정보를 가져올 수 없습니다.' });
        
        res.json(details);

    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: '서버 에러: ' + e.message }); 
    }
});

// 2. 특정 채널의 재생목록 리스트 가져오기 (기존 유지)
app.get('/api/channel-playlists', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'Channel ID is required' });

    try {
        let allPlaylists = [];
        let nextPageToken = null;
        do {
            const response = await youtube.playlists.list({
                part: 'snippet,contentDetails',
                channelId: channelId,
                maxResults: 50,
                pageToken: nextPageToken
            });
            const playlists = response.data.items.map(item => ({
                id: item.id,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default.url,
                itemCount: item.contentDetails.itemCount
            }));
            allPlaylists = allPlaylists.concat(playlists);
            nextPageToken = response.data.nextPageToken;
        } while (nextPageToken);
        res.json({ playlists: allPlaylists });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});

// 3. 특정 재생목록의 동영상 리스트 가져오기 (기존 유지)
app.get('/api/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  const { pageToken } = req.query;

  try {
    const playlistItemsResponse = await youtube.playlistItems.list({
      part: 'snippet,contentDetails',
      playlistId: playlistId,
      maxResults: 50,
      pageToken: pageToken || undefined,
    });

    const items = playlistItemsResponse.data.items || [];
    const nextPageToken = playlistItemsResponse.data.nextPageToken;
    const totalResults = playlistItemsResponse.data.pageInfo.totalResults;

    if (items.length === 0) {
        return res.json({ 
            videos: [], 
            nextPageToken: null, 
            totalCount: totalResults 
        });
    }

    const videoIds = items.map(item => item.contentDetails?.videoId).filter(id => id);

    let videos = [];
    if (videoIds.length > 0) {
        const videoDetailsResponse = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: videoIds.join(','),
        });

        const detailsMap = new Map();
        videoDetailsResponse.data.items.forEach(v => {
            detailsMap.set(v.id, v);
        });

        videos = videoIds.map(id => {
            const detail = detailsMap.get(id);
            if (!detail) return null;
            return {
                id: detail.id,
                title: detail.snippet.title,
                thumbnail: detail.snippet.thumbnails.medium?.url || detail.snippet.thumbnails.default.url,
                publishedAt: detail.snippet.publishedAt,
                duration: detail.contentDetails.duration,
            };
        }).filter(v => v); 
    }

    res.json({ 
        videos, 
        nextPageToken: nextPageToken || null, 
        totalCount: totalResults 
    });

  } catch (error) {
    console.error('Playlist Fetch Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(port, () => console.log(`Server listening at port ${port}`));