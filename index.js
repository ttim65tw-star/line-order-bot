const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// 記錄群組點餐狀態的記憶體資料庫 (正式上線可改接 MongoDB / Supabase)
const groupStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  // 處理機器人被加入群組的事件（加上 try-catch 防止報錯退群）
  if (event.type === 'join') {
    try {
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: '大家好！我是點餐神助手 🍽️\n只要傳送「哈囉」或上傳菜單，我就能幫忙！'
      });
    } catch (err) {
      console.error('Join event error:', err);
    }
    return Promise.resolve(null);
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  const groupId = event.source.groupId || event.source.userId;

  if (text === '哈囉' || text === 'hi') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '你好！我是點餐神助手，隨時準備為大家服務。'
    });
  }

  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
