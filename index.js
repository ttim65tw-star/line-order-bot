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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const text = event.message.text.trim();
  const groupId = event.source.groupId || event.source.userId;

  // 初始化群組狀態
  if (!groupStates[groupId]) {
    groupStates[groupId] = { status: 'IDLE', menu: [], orders: {} };
  }

  const state = groupStates[groupId];

  // 測試回應
  if (text === '哈囉' || text === 'hi') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '你好！我是點餐神助手，傳送菜單照片即可開始開單。'
    });
  }

  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
