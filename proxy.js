const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/home/popfeeder', async (req, res) => {
  const id = req.query.id || '';
  const date = req.query.date || '';

  if (!id) {
    return res.json({ success: false, data: [] });
  }

  try {
    const params = { id };
    if (date) params.date = date;

    const response = await axios.get('http://85.185.251.108:8007/home/popfeeder', {
      params,
      timeout: 15000,
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,fa-IR;q=0.8,fa;q=0.7',
        'Origin': 'http://www.kpedc.com',
        'Referer': 'http://www.kpedc.com/',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
      },
      validateStatus: () => true
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    res.json({ success: false, data: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
