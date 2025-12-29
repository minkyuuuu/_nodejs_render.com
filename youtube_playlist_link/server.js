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

// 3. 특정 재생목록의 동영상 리스트 가져오기
app.get('/api/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  try {
    const playlistResponse = await youtube.playlists.list({ part: 'snippet', id: playlistId });
    if (playlistResponse.data.items.length === 0) return res.status(404).json({ error: 'Playlist not found.' });
    const playlistTitle = playlistResponse.data.items[0].snippet.title;

    let videoIds = [];
    let nextPageToken = null;
    do {
      const playlistItemsResponse = await youtube.playlistItems.list({
        part: 'snippet',
        playlistId: playlistId,
        maxResults: 50,
        pageToken: nextPageToken,
      });
      playlistItemsResponse.data.items.forEach(item => {
        if (item.snippet?.resourceId?.videoId) videoIds.push(item.snippet.resourceId.videoId);
      });
      nextPageToken = playlistItemsResponse.data.nextPageToken;
    } while (nextPageToken);

    let allVideoDetails = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      const videoIdChunk = videoIds.slice(i, i + 50);
      const videoDetailsResponse = await youtube.videos.list({
        part: 'snippet,contentDetails',
        id: videoIdChunk.join(','),
      });
      allVideoDetails = allVideoDetails.concat(videoDetailsResponse.data.items);
    }
    const videos = allVideoDetails.map(item => ({
      id: item.id,
      title: item.snippet.title,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default.url,
      publishedAt: item.snippet.publishedAt,
      duration: item.contentDetails.duration,
    }));
    const sortedVideos = videoIds.map(id => videos.find(video => video.id === id)).filter(Boolean);
    res.json({ playlistTitle, totalCount: videoIds.length, videos: sortedVideos });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

app.listen(port, () => console.log(`Server listening at port ${port}`));