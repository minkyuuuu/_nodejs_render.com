const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(cors());
app.use(express.static('public'));

const youtube = google.youtube({
  version: 'v3',
  auth: process.env.YOUTUBE_API_KEY,
});

// ---------------------------------------------------------
// 1. 유튜버 핸들(ID)로 채널 정보 찾기 (추가된 기능)
// ---------------------------------------------------------
app.get('/api/find-channel', async (req, res) => {
    const { handle } = req.query; // 클라이언트에서 ?handle=@abc 형태로 보냄
    if (!handle) return res.status(400).json({ error: 'Handle is required' });

    try {
        // search.list를 사용하여 채널 검색
        const response = await youtube.search.list({
            part: 'snippet',
            type: 'channel',
            q: handle, // 검색어 (@핸들)
            maxResults: 1, // 가장 정확한 1개만
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
        console.error('Channel Search Error:', error.message);
        res.status(500).json({ error: 'Failed to search channel' });
    }
});

// ---------------------------------------------------------
// 2. 특정 채널의 재생목록 리스트 가져오기 (추가된 기능)
// ---------------------------------------------------------
app.get('/api/channel-playlists', async (req, res) => {
    const { channelId } = req.query;
    if (!channelId) return res.status(400).json({ error: 'Channel ID is required' });

    try {
        let allPlaylists = [];
        let nextPageToken = null;

        // 재생목록이 50개가 넘을 수 있으니 페이지네이션 처리
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
        console.error('Playlist Fetch Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});

// ---------------------------------------------------------
// 3. 특정 재생목록의 동영상 리스트 가져오기 (기존 기능 유지)
// ---------------------------------------------------------
app.get('/api/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  if (!playlistId) return res.status(400).json({ error: 'Playlist ID is required' });

  try {
    // 3-1. 재생목록 기본 정보
    const playlistResponse = await youtube.playlists.list({
        part: 'snippet',
        id: playlistId,
    });

    if (playlistResponse.data.items.length === 0) {
      return res.status(404).json({ error: 'Playlist not found.' });
    }
    const playlistTitle = playlistResponse.data.items[0].snippet.title;

    // 3-2. 동영상 ID 가져오기
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

    // 3-3. 동영상 상세 정보 (duration 등)
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
    
    // 순서 정렬
    const sortedVideos = videoIds.map(id => videos.find(video => video.id === id)).filter(Boolean);

    res.json({
      playlistTitle,
      totalCount: videoIds.length,
      videos: sortedVideos,
    });

  } catch (error) {
    console.error('Error fetching YouTube data:', error.message);
    res.status(500).json({ error: 'Failed to fetch data from YouTube API.', details: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});