require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const sgMail = require('@sendgrid/mail');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: "*", // allow all origins
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Set up SendGrid if API key exists
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Constants for APIs
const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-5-chat';

if (!OPENROUTER_KEY) {
  console.warn('⚠️  OPENROUTER_API_KEY not set in .env — endpoints will fail until set.');
}

/* -----------------------
  IMAGE & VIDEO GENERATION ENDPOINTS
  ----------------------- */

// ImgBB Upload
app.post('/api/upload-image', async (req, res) => {
  try {
    const { base64Image } = req.body;
    if (!base64Image?.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid or missing base64 image' });
    }

    const base64Data = base64Image.split(',')[1];
    const form = new FormData();
    form.append('key', 'b064e36c9b67c3131bc5b07def68087b');
    form.append('image', base64Data);

    const uploadRes = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: form.getHeaders(),
    });

    res.json({ imageUrl: uploadRes.data.data.url });
  } catch (err) {
    console.error('ImgBB upload error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to upload image to ImgBB' });
  }
});

// RunwayML Text to Image (Submit Task ONLY - return ID)
app.post('/api/text-to-image', async (req, res) => {
  const { promptText, ratio, seed, referenceImages } = req.body;

  try {
    const runwayRes = await axios.post(
      'https://api.dev.runwayml.com/v1/text_to_image',
      {
        model: 'gen4_image',
        promptText,
        ratio,
        seed,
        referenceImages,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer key_7342d60f6365d42b919e1ae0f370adab5bf524fe1f5603211226027dc1fb463a1c5569c1cd3683cdc50bcf1b38a754dc9c02a753d54a805215b06ba2cf5ac28f`,
          'X-Runway-Version': '2024-11-06',
        },
      }
    );

    const taskId = runwayRes.data?.id;

    if (!taskId) {
      console.error('No task ID returned:', runwayRes.data);
      return res.status(500).json({ error: 'RunwayML did not return a task ID' });
    }

    res.json({ id: taskId });
  } catch (err) {
    console.error('RunwayML submit error:', err.response?.data || err.message);
    res.status(500).json({ error: 'RunwayML API submission failed' });
  }
});

// Poll Image Status
app.get('/api/poll-image-status/:taskId', async (req, res) => {
  const { taskId } = req.params;

  try {
    const response = await axios.get(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer key_7342d60f6365d42b919e1ae0f370adab5bf524fe1f5603211226027dc1fb463a1c5569c1cd3683cdc50bcf1b38a754dc9c02a753d54a805215b06ba2cf5ac28f`,
        'X-Runway-Version': '2024-11-06',
      },
    });

    res.json(response.data);
  } catch (error) {
    console.error('RunwayML polling error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Polling RunwayML task status failed' });
  }
});

// Generate Video with RunwayML
app.post('/api/generate-video', async (req, res) => {
  const { promptText, ratio, duration, seed, promptImage } = req.body;

  try {
    const response = await axios.post(
      'https://api.dev.runwayml.com/v1/image_to_video',
      {
        model: 'gen4_turbo',
        promptText,
        promptImage,
        ratio,
        duration,
        seed
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer key_7342d60f6365d42b919e1ae0f370adab5bf524fe1f5603211226027dc1fb463a1c5569c1cd3683cdc50bcf1b38a754dc9c02a753d54a805215b06ba2cf5ac28f`,
          'X-Runway-Version': '2024-11-06',
        }
      }
    );

    const taskId = response.data?.id;

    if (!taskId) {
      return res.status(500).json({ error: 'RunwayML did not return a task ID' });
    }

    res.json({ id: taskId });

  } catch (error) {
    console.error('RunwayML generate-video error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Video generation API failed' });
  }
});

// Check Status of Video Generation Task
app.get('/api/check-status/:taskId', async (req, res) => {
  const { taskId } = req.params;

  try {
    const statusRes = await axios.get(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer key_7342d60f6365d42b919e1ae0f370adab5bf524fe1f5603211226027dc1fb463a1c5569c1cd3683cdc50bcf1b38a754dc9c02a753d54a805215b06ba2cf5ac28f`,
        'X-Runway-Version': '2024-11-06',
      },
    });

    res.json(statusRes.data);
  } catch (error) {
    console.error('Video task status check error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to get video generation status' });
  }
});

/* -----------------------
  MARKETING ENDPOINTS (OpenRouter powered)
  ----------------------- */

// Helper: call OpenRouter and expect a JSON-only response
async function callOpenRouter(userPrompt, instructions = '') {
  const system = {
    role: 'system',
    content:
      "You are a backend assistant that transforms marketing form input into a structured JSON response. " +
      "IMPORTANT: Return exactly one JSON object and nothing else (no backticks, no extra text). " +
      "If asked to generate content, include fields described in the prompt. " +
      "If no output is possible, return { \"ok\": false, \"error\": \"reason\" }."
  };

  const user = {
    role: 'user',
    content: instructions + '\n\n' + userPrompt
  };

  try {
    const resp = await axios.post(
      OPENROUTER_API,
      {
        model: OPENROUTER_MODEL,
        messages: [system, user],
        temperature: 0.7,
        max_tokens: 900
      },
      {
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' }
      }
    );

    const choice = resp.data?.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? null;

    if (!text) return { ok: false, error: 'no response from model' };

    // Try to parse JSON
    try {
      const parsed = JSON.parse(text);
      return parsed;
    } catch (e) {
      // If model didn't return strict JSON, return raw text in a fallback object
      return { ok: true, raw: text };
    }
  } catch (err) {
    console.error('OpenRouter error', err?.response?.data || err.message);
    return { ok: false, error: err?.response?.data || err.message };
  }
}

/* --------------
  ENDPOINTS: one per form. Each endpoint:
   - accepts JSON form data in req.body
   - uses callOpenRouter(...) with a tailored prompt that asks the model to return a JSON object
   - returns that JSON to the frontend
  -------------- */

/* -----------------------
  ADVERTISEMENT CAMPAIGNING
   - Google Ads
   - Facebook/Instagram Ads
   - YouTube Ads
   - Event Ad Campaign
  ----------------------- */

// 1) Google Ads Campaign Form
// app.post('/api/ads/google', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Form: Google Ads Campaign creation. Input: ${JSON.stringify(body)}.
// Return JSON: {
//   ok: true,
//   campaignDraft: { name, headlines:[...], descriptions:[...], keywords:[...], budget: {daily, total}, targeting:{locations,audiences} },
//   previewAdText: "...",
//   notes: "any tips or warnings"
// }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 2) Facebook/Instagram Ads Form
// app.post('/api/ads/meta', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Form: Facebook/Instagram Ads. Input: ${JSON.stringify(body)}.
// Return JSON: {
//   ok:true,
//   creativeSuggestions:{ caption, primaryText, headline, cta },
//   adPayload: { platform, audience, creativeUrl },
//   notes: "any sizing/format tips"
// }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 3) YouTube Ads Form
// app.post('/api/ads/youtube', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `YouTube Ads creation. Input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, adScript: "...", adDescription: "...", tags:[...], targeting:{...} }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 4) Event Ad Campaign Form
// app.post('/api/ads/event', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Event Ad campaign. Input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, headline, bannerText, shortDescription, suggestedSizes:[...], cta }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  CONTENT MARKETING
   - Blog Content Brief
   - Product Description
   - Video Script Brief
   - Infographic Brief
  ----------------------- */

// 1) Blog Content Brief
app.post('/api/content/blog', async (req, res) => {
  const body = req.body || {};
  const prompt = `Create a blog content brief for input: ${JSON.stringify(body)}.
Return JSON:
{
  ok:true,
  title: "...",
  outline: [ {heading:"", subheadings:["",""], suggestedWords:300 }, ... ],
  metaDescription: "...",
  seoKeywords:[...]
}`;
  const result = await callOpenRouter(prompt);
  res.json(result);
});

// 2) Product Description
// app.post('/api/content/product-description', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Write product description and bullets. Input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, bullets:[...], seoParagraph:"..." }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 3) Video Script Brief
// app.post('/api/content/video-script', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create a video script (include visual cues) for input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, scriptText: "...", timestamps: [ {sec:0, text:"..."}, ... ], ttsNote: "if you want TTS" }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 4) Infographic Brief
// app.post('/api/content/infographic', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create an infographic brief for input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, layout:[ {section:"", text:"", visual:"icon/chart"} ], suggestedColors:[...], exportText:"..." }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  EMAIL MARKETING
   - Email Campaign Creation
   - Drip Automation
  ----------------------- */

// 1) Email Campaign Creation
// app.post('/api/email/campaign', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Generate an email campaign from: ${JSON.stringify(body)}.
// Return JSON: { ok:true, subject:"...", htmlBody:"<p>...</p>", textBody:"...", cta:"..." }`;
//   const result = await callOpenRouter(prompt);

//   // Optionally send via SendGrid if sendNow:true and SENDGRID_API_KEY set
//   if (body.sendNow && process.env.SENDGRID_API_KEY && result && result.ok) {
//     try {
//       await sgMail.send({
//         to: body.testTo || 'test@example.com',
//         from: body.from || 'no-reply@example.com',
//         subject: result.subject || body.subjectHint || 'Campaign',
//         html: result.htmlBody || result.raw || '<p></p>'
//       });
//       result.sent = true;
//       result.sentTo = body.testTo || 'test@example.com';
//     } catch (e) {
//       result.sent = false;
//       result.sendError = (e && e.message) || String(e);
//     }
//   }

//   res.json(result);
// });

// 2) Drip Automation
// app.post('/api/email/drip', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create a drip email sequence for input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, steps: [ {delayHours:0, subject:"...", html:"<p>..</p>"}, ... ] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  EVENTS & WEBINARS
   - Webinar Signup
   - Event Campaign
  ----------------------- */

// 1) Webinar Signup
// app.post('/api/events/webinar', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Setup Webinar confirmation + email copy for input: ${JSON.stringify(body)}.
// Return JSON: { ok:true, schedule:{title, startTime, duration}, confirmationEmail:{subject, html}, joinInfoNote:"If connected to Zoom use OAuth"} }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// 2) Event Campaign
// app.post('/api/events/campaign', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create event campaign assets for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, headline, bannerText, socialCopy:{twitter, linkedin, instagram}, promotionPlan:["meta","email"] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  INTERNAL MARKETING PLANNING
   - Campaign Approval Form
   - Budget Allocation Form
  ----------------------- */

// Campaign Approval
// app.post('/api/internal/approval', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create a campaign approval review for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, approvalStatus:"pending/approved/needs_changes", comments:[...], sheetRow:{id, link} }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// Budget Allocation
// app.post('/api/internal/budget', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Propose budget allocations for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, allocations:[ {team, amount, rationale} ], summary:"..." }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  PRODUCT MARKETING
   - Product Launch
   - Upsell Email
  ----------------------- */

// Product Launch
// app.post('/api/product/launch', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create product launch plan & copy for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, heroCopy, emailSequence:[...], socialPlan:[...], assets:[{type, filename}] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// Upsell Email
// app.post('/api/product/upsell', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Write an upsell email for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, subject, htmlBody, offerCode }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  DIGITAL MARKETING TOOLS / STATS
   - KPI Tracker Form
   - A/B Test Tracker Form
  ----------------------- */

// KPI Tracker
// app.post('/api/tools/kpi', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Record KPI (demo) for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, recorded:{metric, value, timestamp}, trendSuggestion:"up/down/neutral" }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// A/B Test Tracker
// app.post('/api/tools/abtest', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Propose A/B test tracking plan for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, variantMetricsTemplate:{}, sampleSizeEstimate: 1000, analysisPlan: "..." }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  SOCIAL MEDIA MANAGEMENT
   - Post Scheduler
   - Caption Generator
  ----------------------- */

// Post Scheduler (demo only — returns schedule payload)
// app.post('/api/social/schedule', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Schedule post (demo) for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, scheduled:{platform,channelId,mediaUrl,scheduleAt}, previewUrl:"..." }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// Caption Generator
// app.post('/api/social/caption', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Generate captions + hashtags for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, captions:[ {length:'short', text:'...'}, {length:'long', text:'...'} ], hashtags:[...] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  SALES PROMOTION MANAGER
   - Offer Campaign
   - Loyalty Program
  ----------------------- */

// Offer Campaign
// app.post('/api/sales/offer', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create an offer campaign for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, bannerText, emailCopy, adCopy, couponCode }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// Loyalty Program
// app.post('/api/sales/loyalty', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Design a loyalty program for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, tiers:[{name,criteria,benefits}], communicationPlan:[...] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  BRANDING
   - Brand Identity
   - Tagline Generator
  ----------------------- */

// Brand Identity
// app.post('/api/branding/identity', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Create a brand identity brief for: ${JSON.stringify(body)}.
// Return JSON: { ok:true, logoIdeas:[...], colorPalettes:[...], fontSuggestions:[...] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

// Tagline Generator
// app.post('/api/branding/tagline', async (req, res) => {
//   const body = req.body || {};
//   const prompt = `Generate ${body.count || 6} taglines for brand: ${JSON.stringify(body)}.
// Return JSON: { ok:true, taglines:[ "one", "two" ] }`;
//   const result = await callOpenRouter(prompt);
//   res.json(result);
// });

/* -----------------------
  HEALTH CHECK
  ----------------------- */
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* -----------------------
  START SERVER
  ----------------------- */
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));