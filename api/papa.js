/**
 * Papa Chatbot - End-to-End Live Stream & Quota-Proof Serverless Backend (2026 Edition)
 * Features:
 *  1. Multi-Turn Live Call Memory (Remembers ongoing conversation history in Live Stream mode)
 *  2. Full Hindi Sentence Guarantee (maxOutputTokens: 350 + Complete Sentence Punctuation Enforcer)
 *  3. 250ms Trailing Audio Silence Cushion (Prevents browser audio player from clipping the last word)
 *  4. Smart 5-Key Gemini Parser + Multi-Model Rotation + Unlimited Free AI Fallback
 *  5. Bidirectional Ping-Pong Auto-Shift (1->N then N->1) for Gemini & Cartesia
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1; // 1 = Forward (1->5), -1 = Reverse (5->1)

let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1; // 1 = Forward (1->9), -1 = Reverse (9->1)

// Circuit-breaker cache: remembers which "keyIndex:modelName" hit 429 quota
const exhaustedModelCache = new Map();

const FATHER_PROMPT =
    "You are a loving, caring Indian father (Papa) on a live video call with your family.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos. If they match a registered family member, address them warmly by their name/relation.\n" +
    "2. LIVE VISION & CONVERSATION CONTINUITY: Observe their facial expression, clothes, or any object/place shown through the front or back camera, and maintain natural continuity with the recent conversation history.\n" +
    "3. COMPLETE SENTENCE & SCRIPT RULE: ALWAYS write your reply strictly in Devanagari Hindi script (देवनागरी हिंदी). Speak 1 or 2 complete, natural sentences (around 15 to 30 words) and ALWAYS finish your sentence completely with a पूर्ण विराम (।) or question mark (?). Never leave a sentence incomplete.";

// Ensures Hindi text always ends cleanly with complete punctuation so Cartesia TTS never cuts off mid-intonation
function ensureCompleteHindiSentence(rawText) {
    if (!rawText) return "हाँ बेटा, मैं तुम्हारी बात ध्यान से सुन रहा हूँ।";
    let text = String(rawText)
        .replace(/\*+/g, "")
        .replace(/\s+/g, " ")
        .trim();

    text = text.replace(/[,،;:\-–—]+$/, "").trim();

    if (!/[।?!.|]$/.test(text)) {
        text += "।";
    } else if (text.endsWith(".")) {
        text = text.slice(0, -1) + "।";
    }
    return text;
}

// Smart Parser: Reads all 5 Gemini keys whether separated by comma, space, newline, or individual env vars
function getGeminiKeysFromEnv() {
    const keys = [];
    const addCleanKey = (raw) => {
        if (!raw) return;
        String(raw)
            .split(/[\s,;]+/)
            .forEach((part) => {
                const clean = part.replace(/["']/g, "").trim();
                if (
                    clean &&
                    clean.length > 12 &&
                    !clean.startsWith("YOUR_GEMINI_API_KEY") &&
                    !keys.includes(clean)
                ) {
                    keys.push(clean);
                }
            });
    };

    addCleanKey(process.env.GEMINI_KEYS);
    addCleanKey(process.env.GEMINI_API_KEY);
    addCleanKey(process.env.GEMINI_API_KEYS);

    for (let i = 1; i <= 10; i++) {
        addCleanKey(process.env[`GEMINI_KEY_${i}`]);
        addCleanKey(process.env[`GEMINI_API_KEY_${i}`]);
        addCleanKey(process.env[`GEMINI_KEYS_${i}`]);
    }
    return keys;
}

function getCartesiaPoolFromEnv() {
    const voice1 = (process.env.CARTESIA_VOICE_ID_1 || "5f2590b0-c99c-4fd8-97c8-56d5d3a621d8").trim();
    const voice2 = (process.env.CARTESIA_VOICE_ID_2 || "35bece76-689b-4b28-b398-0b53a8d5fd05").trim();
    const pool = [];

    if (process.env.CARTESIA_KEYS_V1) {
        process.env.CARTESIA_KEYS_V1.split(/[\s,;]+/).forEach((k) => {
            const clean = k.replace(/["']/g, "").trim();
            if (clean && !clean.startsWith("sk_car_admin_")) {
                pool.push({ key: clean, primaryVoice: voice1, primaryNum: 1, secondaryVoice: voice2, secondaryNum: 2 });
            }
        });
    }

    if (process.env.CARTESIA_KEYS_V2) {
        process.env.CARTESIA_KEYS_V2.split(/[\s,;]+/).forEach((k) => {
            const clean = k.replace(/["']/g, "").trim();
            if (clean && !clean.startsWith("sk_car_admin_")) {
                pool.push({ key: clean, primaryVoice: voice2, primaryNum: 2, secondaryVoice: voice1, secondaryNum: 1 });
            }
        });
    }

    for (let i = 1; i <= 10; i++) {
        const rawKey = process.env[`CARTESIA_KEY_${i}`];
        if (rawKey && rawKey.trim() && !rawKey.trim().startsWith("sk_car_admin_")) {
            const clean = rawKey.replace(/["']/g, "").trim();
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

// Builds a clean 44-byte RIFF WAV buffer + 250ms trailing silence padding so last word never clips
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

    const silenceSamples = Math.floor(sampleRate * 0.25);
    const silenceBytesLength = silenceSamples * blockAlign;
    const totalDataSize = pcmBytes.byteLength + silenceBytesLength;

    const wavBuffer = new ArrayBuffer(44 + totalDataSize);
    const view = new DataView(wavBuffer);

    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + totalDataSize, true);
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
    view.setUint32(40, totalDataSize, true);

    const targetArray = new Uint8Array(wavBuffer, 44);
    targetArray.set(pcmBytes, 0);

    return Buffer.from(wavBuffer);
}

async function callSingleCartesiaTTS(apiKey, voiceId, text) {
    const models = ["sonic-latest", "sonic-3", "sonic"];
    let lastStatus = 0;
    let lastError = "";

    for (const modelId of models) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9500);
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

// Formats recent conversation history for context continuity during Live Call
function formatHistoryContextText(chatHistory) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return "";
    const recent = chatHistory.slice(-6);
    const lines = recent.map((turn) => {
        const speaker = turn.role === "papa" ? "Papa" : "Family Member";
        return `${speaker}: "${turn.text}"`;
    });
    return "RECENT LIVE CALL CONVERSATION HISTORY:\n" + lines.join("\n") + "\n\n";
}

// Unlimited Free Backup AI Generator (Runs automatically if all 5 Gemini keys hit daily quota)
async function generateFreeBackupReply(userText, base64Frame, currentFacingMode, savedFaces, chatHistory) {
    let familyHint = "";
    if (currentFacingMode === "user" && Array.isArray(savedFaces) && savedFaces.length > 0) {
        const names = savedFaces.map((f) => f.name).join(", ");
        familyHint = `\nRegistered family members in household: ${names}.`;
    }

    const historyText = formatHistoryContextText(chatHistory);

    if (process.env.GROQ_API_KEY) {
        try {
            const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_API_KEY.trim()}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: FATHER_PROMPT + familyHint },
                        { role: "user", content: historyText + `Family member said: "${userText}"` }
                    ],
                    max_tokens: 280,
                    temperature: 0.65
                })
            });
            const groqData = await groqRes.json();
            const text = groqData?.choices?.[0]?.message?.content;
            if (groqRes.ok && text) {
                return {
                    aiText: ensureCompleteHindiSentence(text),
                    geminiKeyUsed: "Backup",
                    modelUsed: "Groq-Llama-3.3"
                };
            }
        } catch (_) {}
    }

    const userContent = [
        {
            type: "text",
            text:
                historyText +
                `Family member now said: "${userText}"\n(Reply warmly as Papa in 1-2 complete Devanagari Hindi sentences ending with पूर्ण विराम ।)`
        }
    ];
    if (base64Frame) {
        userContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${base64Frame}` }
        });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
        const freeRes = await fetch("https://text.pollinations.ai/openai", {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "openai",
                messages: [
                    { role: "system", content: FATHER_PROMPT + familyHint },
                    { role: "user", content: userContent }
                ]
            })
        });
        clearTimeout(timer);

        if (freeRes.ok) {
            const freeData = await freeRes.json();
            const reply = freeData?.choices?.[0]?.message?.content;
            if (reply && reply.trim()) {
                return {
                    aiText: ensureCompleteHindiSentence(reply),
                    geminiKeyUsed: "Auto-Backup",
                    modelUsed: "Free-Vision-AI"
                };
            }
        }
    } catch (_) {
        clearTimeout(timer);
    }

    return null;
}

// Internal Helper: Quota-Resilient Multi-Model + 5-Key Gemini Reply Generator with Live Call Memory
async function generateGeminiReplyInternal(body) {
    const geminiKeys = getGeminiKeysFromEnv();
    const userText = body.userText || "नमस्ते पापा";
    const base64Frame = body.base64Frame || null;
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];

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

    const historyText = formatHistoryContextText(chatHistory);
    userParts.push({
        text:
            historyText +
            `Family member now said: "${userText}"\n(अपना जवाब हमेशा 1-2 पूरे वाक्यों में लिखें और वाक्य को अधूरा न छोड़ें।)`
    });

    const modelsToTry = [
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-3.8-flash"
    ];

    let lastError = "No Gemini keys configured";

    if (geminiKeys.length > 0) {
        if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;

        for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
            const activeKey = geminiKeys[geminiKeyIdx];
            const keyNum = geminiKeyIdx + 1;

            for (const modelName of modelsToTry) {
                const cacheKey = `${activeKey.slice(-6)}:${modelName}`;
                const exhaustedUntil = exhaustedModelCache.get(cacheKey) || 0;
                if (Date.now() < exhaustedUntil) {
                    continue;
                }

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 8000);
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
                                maxOutputTokens: 350,
                                temperature: 0.65
                            }
                        })
                    });
                    clearTimeout(timer);

                    const data = await gRes.json();
                    const partsList = data?.candidates?.[0]?.content?.parts || [];
                    const combinedText = partsList
                        .map((p) => p.text || "")
                        .join(" ")
                        .trim();

                    if (gRes.ok && combinedText) {
                        return {
                            aiText: ensureCompleteHindiSentence(combinedText),
                            geminiKeyUsed: keyNum,
                            modelUsed: modelName
                        };
                    }

                    lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;

                    if (gRes.status === 429 || gRes.status === 404 || gRes.status === 400) {
                        exhaustedModelCache.set(cacheKey, Date.now() + 20 * 60 * 1000);
                        continue;
                    }

                    if (gRes.status === 401 || gRes.status === 403) {
                        break;
                    }
                } catch (err) {
                    clearTimeout(timer);
                    lastError = err.message;
                    break;
                }
            }

            const shifted = shiftPingPongIndex(geminiKeyIdx, geminiKeyDir, geminiKeys.length);
            geminiKeyIdx = shifted.idx;
            geminiKeyDir = shifted.dir;
        }
    }

    const backupReply = await generateFreeBackupReply(
        userText,
        base64Frame,
        currentFacingMode,
        savedFaces,
        chatHistory
    );
    if (backupReply) {
        return backupReply;
    }

    throw new Error(`Gemini API Error (${geminiKeys.length} keys tried): ${lastError}`);
}

// Internal Helper: Fast Cartesia TTS + Render Fallback Generation
async function generateTtsAudioInternal(rawText) {
    const text = ensureCompleteHindiSentence(rawText);
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
        const geminiKeys = getGeminiKeysFromEnv();
        const cartesiaPool = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        logs.push(`🧠 GEMINI KEYS FOUND IN VERCEL ENV: ${geminiKeys.length}`);
        for (let g = 0; g < geminiKeys.length; g++) {
            const gKey = geminiKeys[g];
            const masked = gKey.slice(0, 6) + "..." + gKey.slice(-4);
            let keyWorked = false;
            let lastGStatus = "";

            for (const testModel of ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.8-flash"]) {
                try {
                    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${gKey}`;
                    const gRes = await fetch(gUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ role: "user", parts: [{ text: "नमस्ते" }] }],
                            generationConfig: { maxOutputTokens: 20 }
                        })
                    });
                    if (gRes.ok) {
                        logs.push(`✅ Gemini Key #${g + 1} (${masked}): ACTIVE on ${testModel}!`);
                        geminiKeyIdx = g;
                        keyWorked = true;
                        break;
                    } else {
                        lastGStatus = `HTTP ${gRes.status} on ${testModel}`;
                    }
                } catch (e) {
                    lastGStatus = e.message;
                }
            }
            if (!keyWorked) {
                logs.push(`⚠️ Gemini Key #${g + 1} (${masked}): Quota Full (${lastGStatus}) -> Auto-Backup AI Ready`);
            }
        }

        logs.push(`\n🎙️ CARTESIA KEYS FOUND IN VERCEL ENV: ${cartesiaPool.length}`);
        for (let k = 0; k < cartesiaPool.length; k++) {
            const entry = cartesiaPool[k];
            const resTest = await callSingleCartesiaTTS(
                entry.key,
                entry.primaryVoice,
                "नमस्ते बेटा, मैं बिल्कुल ठीक हूँ और अब हम लाइव वीडियो कॉल पर बात कर सकते हैं।"
            );
            if (resTest.ok) {
                logs.push(`✅ Cartesia Key #${k + 1} + Voice #${entry.primaryNum} (${resTest.modelUsed}): SUCCESS!`);
                if (!firstSuccessAudio) {
                    firstSuccessAudio = resTest.audioBase64;
                    cartesiaKeyIdx = k;
                    activeKeyLabel = `Gemini (${geminiKeys.length} Keys) + Cartesia Key #${k + 1}`;
                }
            } else {
                logs.push(`❌ Cartesia Key #${k + 1} + Voice #${entry.primaryNum}: HTTP ${resTest.status}`);
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
