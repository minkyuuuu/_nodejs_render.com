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

// 1. 유튜버 핸들(ID)로 채널 정보 찾기
app.get('/api/find-channel', async (req, res) => {
    const { handle } = req.query;
    if (!handle) return res.status(400).json({ error: 'Handle is required' });

    try {
        const response = await youtube.search.list({
            part: 'snippet',
            type: 'channel',
            q: handle,
            maxResults: 1,
        });

        if (response.data.items.length === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        const channel = response.data.items[0];
        res.json({
            channelId: channel.snippet.channelId,
            title: channel.snippet.channelTitle,
            thumbnail: channel.snippet.thumbnails.default.url,
            description: channel.snippet.description
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
// [수정] 한 번에 다 가져오지 않고 50개씩 끊어서 반환하도록 변경
app.get('/api/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  const { pageToken } = req.query; // 클라이언트에서 요청한 페이지 토큰

  try {
    // 1. 재생목록의 아이템들을 50개 단위로 가져옵니다.
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

    // 2. videoId만 추출
    const videoIds = items.map(item => item.contentDetails?.videoId).filter(id => id);

    // 3. 비디오 상세 정보(duration 등) 조회
    let videos = [];
    if (videoIds.length > 0) {
        const videoDetailsResponse = await youtube.videos.list({
            part: 'snippet,contentDetails',
            id: videoIds.join(','),
        });

        // ID 매핑을 위한 Map 생성
        const detailsMap = new Map();
        videoDetailsResponse.data.items.forEach(v => {
            detailsMap.set(v.id, v);
        });

        // 4. playlistItems 순서대로 데이터 병합
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
        }).filter(v => v); // null 제거
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