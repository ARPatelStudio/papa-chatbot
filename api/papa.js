/**
 * Papa Chatbot - High-Speed Vercel Serverless Backend (2026 Quota-Resilient Turbo Edition)
 * Features:
 *  - Per-Model 429 Failover (Automatically switches between gemini-3.5-flash, gemini-3.5-flash-lite, gemini-3.8-flash)
 *  - Circuit-Breaker Cooldown Cache (Skips quota-exhausted models instantly with 0ms delay)
 *  - Bidirectional Ping-Pong Key Rotation (1->N then N->1) for both Gemini & Cartesia
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1; // 1 = Forward (1->5), -1 = Reverse (5->1)

let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1; // 1 = Forward (1->9), -1 = Reverse (9->1)

// Circuit-breaker cache: remembers which "keyIndex:modelName" hit 429 quota so next call is instant
const exhaustedModelCache = new Map();

const FATHER_PROMPT =
    "You are a loving, caring Indian father (Papa) talking to your family.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos. If they match a registered family member, address them warmly by their name/relation.\n" +
    "2. LIVE VISION ABSORPTION: Also observe their facial expression, clothes, or any object/place shown through the front or back camera and respond naturally.\n" +
    "3. SCRIPT RULE: ALWAYS write your reply strictly in Devanagari Hindi script (देवनागरी हिंदी) so the Hindi voice clone pronounces every word clearly. Keep your reply to 1 short, natural sentence.";

function getGeminiKeysFromEnv() {
    const keys = [];
    if (process.env.GEMINI_KEYS) {
        process.env.GEMINI_KEYS.split(",").forEach((k) => {
            const clean = k.trim();
            if (clean && !clean.startsWith("YOUR_GEMINI_API_KEY") && !keys.includes(clean)) {
                keys.push(clean);
            }
        });
    }
    for (let i = 1; i <= 10; i++) {
        const k = process.env[`GEMINI_KEY_${i}`] || process.env[`GEMINI_API_KEY_${i}`];
        if (k && k.trim() && !k.trim().startsWith("YOUR_GEMINI_API_KEY") && !keys.includes(k.trim())) {
            keys.push(k.trim());
        }
    }
    if (process.env.GEMINI_API_KEY && !keys.includes(process.env.GEMINI_API_KEY.trim())) {
        keys.push(process.env.GEMINI_API_KEY.trim());
    }
    return keys;
}

function getCartesiaPoolFromEnv() {
    const voice1 = (process.env.CARTESIA_VOICE_ID_1 || "5f2590b0-c99c-4fd8-97c8-56d5d3a621d8").trim();
    const voice2 = (process.env.CARTESIA_VOICE_ID_2 || "35bece76-689b-4b28-b398-0b53a8d5fd05").trim();
    const pool = [];

    if (process.env.CARTESIA_KEYS_V1) {
        process.env.CARTESIA_KEYS_V1.split(",").forEach((k) => {
            const clean = k.trim();
            if (clean && !clean.startsWith("sk_car_admin_")) {
                pool.push({ key: clean, primaryVoice: voice1, primaryNum: 1, secondaryVoice: voice2, secondaryNum: 2 });
            }
        });
    }

    if (process.env.CARTESIA_KEYS_V2) {
        process.env.CARTESIA_KEYS_V2.split(",").forEach((k) => {
            const clean = k.trim();
            if (clean && !clean.startsWith("sk_car_admin_")) {
                pool.push({ key: clean, primaryVoice: voice2, primaryNum: 2, secondaryVoice: voice1, secondaryNum: 1 });
            }
        });
    }

    for (let i = 1; i <= 10; i++) {
        const rawKey = process.env[`CARTESIA_KEY_${i}`];
        if (rawKey && rawKey.trim() && !rawKey.trim().startsWith("sk_car_admin_")) {
            const clean = rawKey.trim();
            if (!pool.some((item) => item.key === clean)) {
                const isGroup1 = i <= 4;
                pool.push({
                    key: clean,
                    primaryVoice: isGroup1 ? voice1 : voice2,
                    primaryNum: isGroup1 ? 1 : 2,
                    secondaryVoice: isGroup1 ? voice2 : voice1,
                    secondaryNum: isGroup1 ? 2 : 1
                });
            }
        }
    }

    return pool;
}

function shiftPingPongIndex(currentIdx, currentDir, totalLength) {
    if (totalLength <= 1) return { idx: 0, dir: 1 };
    let idx = currentIdx;
    let dir = currentDir;

    if (dir === 1) {
        if (idx < totalLength - 1) {
            idx++;
        } else {
            dir = -1;
            idx--;
        }
    } else {
        if (idx > 0) {
            idx--;
        } else {
            dir = 1;
            idx++;
        }
    }
    return { idx, dir };
}

function buildWavBufferFromPcm(rawArrayBuffer, sampleRate = 24000) {
    let pcmBytes = new Uint8Array(rawArrayBuffer);
    if (
        pcmBytes.byteLength > 44 &&
        pcmBytes[0] === 0x52 &&
        pcmBytes[1] === 0x49 &&
        pcmBytes[2] === 0x46 &&
        pcmBytes[3] === 0x46
    ) {
        pcmBytes = pcmBytes.subarray(44);
    }

    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBytes.byteLength;

    const wavBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuffer);

    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    new Uint8Array(wavBuffer, 44).set(pcmBytes);
    return Buffer.from(wavBuffer);
}

async function callSingleCartesiaTTS(apiKey, voiceId, text) {
    const models = ["sonic-latest", "sonic-3", "sonic"];
    let lastStatus = 0;
    let lastError = "";

    for (const modelId of models) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6500);
        try {
            const res = await fetch("https://api.cartesia.ai/tts/bytes", {
                method: "POST",
                signal: controller.signal,
                headers: {
                    "Cartesia-Version": "2024-11-13",
                    "X-API-Key": apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model_id: modelId,
                    transcript: text,
                    voice: { mode: "id", id: voiceId },
                    language: "hi",
                    output_format: {
                        container: "raw",
                        encoding: "pcm_s16le",
                        sample_rate: 24000
                    }
                })
            });
            clearTimeout(timer);

            if (res.ok) {
                const rawBuf = await res.arrayBuffer();
                if (rawBuf && rawBuf.byteLength > 200) {
                    const wavBuf = buildWavBufferFromPcm(rawBuf, 24000);
                    return {
                        ok: true,
                        audioBase64: wavBuf.toString("base64"),
                        modelUsed: modelId
                    };
                }
            }

            lastStatus = res.status;
            const errTxt = await res.text();
            lastError = errTxt.slice(0, 140);

            if (res.status === 401 || res.status === 402 || res.status === 404 || res.status === 429) {
                break;
            }
        } catch (err) {
            clearTimeout(timer);
            lastStatus = 500;
            lastError = err.message;
            break;
        }
    }

    return { ok: false, status: lastStatus, error: lastError };
}

// Internal Helper: Quota-Resilient Multi-Model + Multi-Key Gemini Reply Generator
async function generateGeminiReplyInternal(body) {
    const geminiKeys = getGeminiKeysFromEnv();
    if (geminiKeys.length === 0) {
        throw new Error("Vercel Environment Variables me GEMINI_KEYS set nahi hai!");
    }

    if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;

    const userText = body.userText || "नमस्ते पापा";
    const base64Frame = body.base64Frame || null;
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];

    const userParts = [];
    if (base64Frame && currentFacingMode === "user" && savedFaces.length > 0) {
        userParts.push({ text: "REGISTERED FAMILY MEMBERS REFERENCE PHOTOS:" });
        for (const member of savedFaces) {
            if (member && member.name && member.photo) {
                userParts.push({ text: `Family Member Name & Relation with Papa: ${member.name}` });
                userParts.push({
                    inline_data: { mime_type: "image/jpeg", data: member.photo }
                });
            }
        }
    }

    if (base64Frame) {
        userParts.push({
            text: `CURRENT LIVE CAMERA VIEW (${currentFacingMode === "user" ? "Front Camera - Person talking to Papa" : "Back Camera - Object/Scene shown to Papa"}):`
        });
        userParts.push({
            inline_data: { mime_type: "image/jpeg", data: base64Frame }
        });
    }

    userParts.push({ text: `Family member said: "${userText}"` });

    // Ordered by High Free-Tier Daily Quota + Low Latency first!
    const modelsToTry = [
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.8-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash"
    ];

    let lastError = "Unknown Gemini Error";
    const maxKeyAttempts = Math.max(geminiKeys.length * 2, 2);

    // Pass 1: Skip models recently marked as 429 exhausted; Pass 2: Retry all if needed
    for (let pass = 0; pass < 2; pass++) {
        for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
            const activeKey = geminiKeys[geminiKeyIdx];
            const keyNum = geminiKeyIdx + 1;

            for (const modelName of modelsToTry) {
                const cacheKey = `${geminiKeyIdx}:${modelName}`;
                const exhaustedUntil = exhaustedModelCache.get(cacheKey) || 0;
                if (pass === 0 && Date.now() < exhaustedUntil) {
                    continue; // Instant skip of quota-exhausted model!
                }

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 7000);
                try {
                    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
                    const gRes = await fetch(url, {
                        method: "POST",
                        signal: controller.signal,
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ role: "user", parts: userParts }],
                            systemInstruction: { parts: [{ text: FATHER_PROMPT }] },
                            generationConfig: {
                                maxOutputTokens: 75,
                                temperature: 0.65
                            }
                        })
                    });
                    clearTimeout(timer);

                    const data = await gRes.json();
                    const replyText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (gRes.ok && replyText) {
                        return {
                            aiText: replyText.trim(),
                            geminiKeyUsed: keyNum,
                            modelUsed: modelName
                        };
                    }

                    lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;

                    // If this specific model hit 429 quota or 404 retired, mark it in cooldown cache for 30 mins
                    // and DO NOT break — immediately try the next model on this SAME API key!
                    if (gRes.status === 429 || gRes.status === 404) {
                        exhaustedModelCache.set(cacheKey, Date.now() + 30 * 60 * 1000);
                        continue;
                    }

                    // Only break out of the model loop if the API key itself is invalid/revoked (401/403)
                    if (gRes.status === 401 || gRes.status === 403) {
                        break;
                    }
                } catch (err) {
                    clearTimeout(timer);
                    lastError = err.message;
                    break;
                }
            }

            // Shift to next Gemini API Key (1->2->3->4->5 then 5->4->3->2->1)
            const shifted = shiftPingPongIndex(geminiKeyIdx, geminiKeyDir, geminiKeys.length);
            geminiKeyIdx = shifted.idx;
            geminiKeyDir = shifted.dir;
        }
    }

    throw new Error(`Gemini API Error: ${lastError}`);
}

// Internal Helper: Fast Cartesia TTS + Render Fallback Generation
async function generateTtsAudioInternal(text) {
    const cartesiaPool = getCartesiaPoolFromEnv();
    const renderUrl = (process.env.RENDER_TTS_URL || "https://papa-voice-cloud.onrender.com/api/tts").trim();
    let lastCartesiaError = "No Cartesia keys configured";

    if (cartesiaPool.length > 0) {
        if (cartesiaKeyIdx >= cartesiaPool.length) cartesiaKeyIdx = 0;

        for (let attempt = 0; attempt < cartesiaPool.length; attempt++) {
            const entry = cartesiaPool[cartesiaKeyIdx];
            const keyNum = cartesiaKeyIdx + 1;

            const result = await callSingleCartesiaTTS(entry.key, entry.primaryVoice, text);
            if (result.ok) {
                return {
                    audioBase64: result.audioBase64,
                    engineLabel: `Cartesia Key #${keyNum} (Voice #${entry.primaryNum} - ${result.modelUsed})`
                };
            }

            lastCartesiaError = `Key #${keyNum} V#${entry.primaryNum} [${result.status}]: ${result.error}`;

            if (result.status === 404) {
                const res2 = await callSingleCartesiaTTS(entry.key, entry.secondaryVoice, text);
                if (res2.ok) {
                    return {
                        audioBase64: res2.audioBase64,
                        engineLabel: `Cartesia Key #${keyNum} (Voice #${entry.secondaryNum} - ${res2.modelUsed})`
                    };
                }
            }

            const shifted = shiftPingPongIndex(cartesiaKeyIdx, cartesiaKeyDir, cartesiaPool.length);
            cartesiaKeyIdx = shifted.idx;
            cartesiaKeyDir = shifted.dir;
        }
    }

    // Fallback to Render Cloud Piper TTS Server
    const rRes = await fetch(renderUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, length_scale: 1.12 })
    });

    if (rRes.ok) {
        const rawWav = await rRes.arrayBuffer();
        const cleanWav = buildWavBufferFromPcm(rawWav, 22050);
        return {
            audioBase64: cleanWav.toString("base64"),
            engineLabel: "Render Cloud Piper TTS"
        };
    }

    throw new Error(`Cartesia (${lastCartesiaError}) & Render (${rRes.status}) both failed.`);
}

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method Not Allowed" });
    }

    const body = req.body || {};
    const action = body.action || "";
    const requiredPin = (process.env.APP_PIN || "1234").trim();

    if (action === "verify_pin") {
        const enteredPin = String(body.pin || "").trim();
        if (enteredPin === requiredPin) {
            return res.status(200).json({ ok: true });
        }
        return res.status(401).json({ ok: false, error: "Wrong PIN" });
    }

    if (String(body.pin || "").trim() !== requiredPin) {
        return res.status(401).json({ error: "Unauthorized PIN" });
    }

    if (action === "chat_and_tts") {
        try {
            const chatResult = await generateGeminiReplyInternal(body);
            const ttsResult = await generateTtsAudioInternal(chatResult.aiText);
            return res.status(200).json({
                aiText: chatResult.aiText,
                geminiKeyUsed: chatResult.geminiKeyUsed,
                modelUsed: chatResult.modelUsed,
                audioBase64: ttsResult.audioBase64,
                engineLabel: `G-Key #${chatResult.geminiKeyUsed} (${chatResult.modelUsed}) | ${ttsResult.engineLabel}`
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (action === "chat") {
        try {
            const chatResult = await generateGeminiReplyInternal(body);
            return res.status(200).json(chatResult);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (action === "tts") {
        const text = (body.text || "").trim();
        if (!text) {
            return res.status(400).json({ error: "Empty text for TTS" });
        }
        try {
            const ttsResult = await generateTtsAudioInternal(text);
            return res.status(200).json(ttsResult);
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }

    if (action === "diag") {
        const cartesiaPool = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        if (cartesiaPool.length === 0) {
            return res.status(200).json({
                logs: ["⚠️ Vercel Environment Variables me CARTESIA_KEYS_V1 / V2 set nahi hain!"],
                foundWorking: false
            });
        }

        for (let k = 0; k < cartesiaPool.length; k++) {
            const entry = cartesiaPool[k];
            const resTest = await callSingleCartesiaTTS(entry.key, entry.primaryVoice, "नमस्ते बेटा, खुश रहो।");
            if (resTest.ok) {
                logs.push(`✅ Key #${k + 1} + Voice #${entry.primaryNum} (${resTest.modelUsed}): SUCCESS!`);
                if (!firstSuccessAudio) {
                    firstSuccessAudio = resTest.audioBase64;
                    cartesiaKeyIdx = k;
                    activeKeyLabel = `Cartesia Key #${k + 1} + Voice #${entry.primaryNum}`;
                }
            } else {
                logs.push(`❌ Key #${k + 1} + Voice #${entry.primaryNum}: HTTP ${resTest.status} - ${resTest.error}`);
            }
        }

        return res.status(200).json({
            logs,
            foundWorking: Boolean(firstSuccessAudio),
            activeKeyLabel,
            audioBase64: firstSuccessAudio
        });
    }

    return res.status(400).json({ error: "Invalid action" });
}
