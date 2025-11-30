const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
// Render 포트 우선, 없으면 3000 (순서 중요)
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

// API 키 확인용 로그 (키가 잘 들어왔는지 서버 시작할 때 확인)
console.log("API Key Loaded:", process.env.YOUTUBE_API_KEY ? "YES" : "NO");

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// 1. 유튜버 핸들(ID)로 채널 정보 찾기
app.get('/api/find-channel', async (req, res) => {
    const { handle } = req.query;
    console.log(`[Search Request] handle: ${handle}`); // 로그 추가

    if (!handle) return res.status(400).json({ error: 'Handle is required' });

    try {
        const response = await youtube.search.list({
            part: 'snippet',
            type: 'channel',
            q: handle,
            maxResults: 1,
        });

        if (response.data.items.length === 0) {
            console.log(`[Search Fail] No channel found for: ${handle}`);
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
        // [중요] Render 로그에 상세 에러 출력
        console.error('[YouTube API Error]:', error.message);
        if (error.response) {
            console.error('[Error Details]:', JSON.stringify(error.response.data, null, 2));
        }
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
        console.error('[Playlist List Error]:', error.message);
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});

// 3. 특정 재생목록의 동영상 리스트 가져오기
app.get('/api/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  if (!playlistId) return res.status(400).json({ error: 'Playlist ID is required' });

  try {
    const playlistResponse = await youtube.playlists.list({
        part: 'snippet',
        id: playlistId,
    });

    if (playlistResponse.data.items.length === 0) {
      return res.status(404).json({ error: 'Playlist not found.' });
    }
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
        if (item.snippet?.resourceId?.videoId) {
            videoIds.push(item.snippet.resourceId.videoId);
        }
      });
      nextPageToken = playlistItemsResponse.data.nextPageToken;
    } while (nextPageToken);

    if (videoIds.length === 0) {
        return res.json({ playlistTitle, totalCount: 0, videos: [] });
    }

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

    res.json({
      playlistTitle,
      totalCount: videoIds.length,
      videos: sortedVideos,
    });

  } catch (error) {
    console.error('[Video List Error]:', error.message);
    res.status(500).json({ error: 'Failed to fetch data from YouTube API.', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening at port ${port}`);
});