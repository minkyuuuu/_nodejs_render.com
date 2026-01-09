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

// [수정됨] 1. 유튜버 핸들(ID)로 채널 정보 찾기 (정확도 개선)
app.get('/api/find-channel', async (req, res) => {
    let { handle } = req.query;
    if (!handle) return res.status(400).json({ error: 'Handle is required' });

    try {
        let response;
        
        // 입력값이 채널 ID 형태(UC로 시작)인지 핸들(@로 시작)인지 구분
        if (handle.startsWith('UC')) {
            // A. 채널 ID로 검색 (channels.list 사용)
            response = await youtube.channels.list({
                part: 'snippet',
                id: handle,
                maxResults: 1,
            });
        } else {
            // B. 핸들로 검색 (channels.list의 forHandle 사용) -> 이게 핵심입니다!
            // 핸들에 @가 없으면 붙여줌
            if (!handle.startsWith('@')) handle = '@' + handle;
            
            response = await youtube.channels.list({
                part: 'snippet',
                forHandle: handle, // 정확한 핸들 일치 검색
                maxResults: 1,
            });
        }

        if (!response.data.items || response.data.items.length === 0) {
            // 검색 결과가 없으면 기존 방식(search.list)으로 한 번 더 시도 (백업 로직)
            // (핸들이 아니라 일반 검색어일 경우를 대비)
            const searchResponse = await youtube.search.list({
                 part: 'snippet',
                 type: 'channel',
                 q: handle,
                 maxResults: 1,
            });
             
            if (searchResponse.data.items.length === 0) {
                return res.status(404).json({ error: 'Channel not found' });
            }
            
            // 검색 결과 사용
            const searchChannel = searchResponse.data.items[0];
            return res.json({
                channelId: searchChannel.snippet.channelId,
                title: searchChannel.snippet.channelTitle,
                thumbnail: searchChannel.snippet.thumbnails.default.url,
                description: searchChannel.snippet.description
            });
        }

        // channels.list 결과 사용 (정확도 100%)
        const channel = response.data.items[0];
        res.json({
            channelId: channel.id, // channels.list는 id가 최상위에 있음
            title: channel.snippet.title,
            thumbnail: channel.snippet.thumbnails.default.url,
            description: channel.snippet.description,
            handle: channel.snippet.customUrl // 실제 핸들 정보
        });

    } catch (error) {
        console.error('[YouTube API Error]:', error.message);
        res.status(500).json({ error: 'Failed to search channel (Server Error)' });
    }
});

// 2. 특정 채널의 재생목록 리스트 가져오기
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

// 3. 특정 재생목록의 동영상 리스트 가져오기 (페이지네이션 적용)
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