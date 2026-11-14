/**
 * Papa Chatbot - Self-Updating Gemini 4 / 3.8 + 4-Voice & 20-Cartesia Keys Backend (Nov 2026 Edition)
 * Features:
 *  1. AUTO-UPDATING GEMINI MODEL ENGINE: Queries Google's live /v1beta/models API automatically so
 *     future Gemini updates (Gemini 4.x, 5.x, Flash-Latest) work forever without code changes!
 *  2. Built-in Glitch & Telemetry Reporter: Returns exact latency (ms), skipped models, and active engine info.
 *  3. Supports 4 Cartesia Voice IDs & 20+ API Keys with Smart Auto-Voice Discovery Cache & Ping-Pong Rotation.
 *  4. 9-Video Emotion Detection + Multi-Turn Live Call Memory + Full Hindi Sentence Guarantee (350 tokens).
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1; // 1 = Forward (1->5), -1 = Reverse (5->1)

let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1; // 1 = Forward (1->20), -1 = Reverse (20->1)

// Circuit-breaker cache for models hitting 429 quota or 404 deprecation
const exhaustedModelCache = new Map();

// Smart Lock Cache: Remembers the exact working { id, num } Voice ID for each Cartesia API key
const keyVoiceLockCache = new Map();

// Auto-Discovered Live Gemini Models Cache (Refreshes automatically from Google servers)
let cachedDiscoveredModels = null;
let lastModelDiscoveryTime = 0;

// Active November 2026 Default Seed List (Used alongside live /v1beta/models discovery)
const NOV_2026_ACTIVE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-4-carbon",
    "gemini-flash-lite-latest",
    "gemini-flash-latest"
];

const FATHER_PROMPT =
    "You are a loving, caring Indian father (Papa) on a live video call with your family.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos. If they match a registered family member, address them warmly by their name/relation.\n" +
    "2. LIVE VISION & CONVERSATION CONTINUITY: Observe their facial expression, clothes, or any object/place shown through the front or back camera, and maintain natural continuity with the recent conversation history.\n" +
    "3. COMPLETE SENTENCE & SCRIPT RULE: ALWAYS write your reply strictly in Devanagari Hindi script (देवनागरी हिंदी). Speak 1 or 2 complete, natural sentences (around 15 to 30 words) and ALWAYS finish your sentence completely with a पूर्ण विराम (।) or question mark (?). Never leave a sentence incomplete.";

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

function getNormalizedReleaseBaseUrl() {
    const raw = (process.env.GITHUB_RELEASE_URL || "").trim();
    if (!raw) return "";
    if (raw.toLowerCase().endsWith(".mp4")) {
        return raw.substring(0, raw.lastIndexOf("/") + 1);
    }
    return raw.endsWith("/") ? raw : raw + "/";
}

function detectPapaEmotion(userText, aiText) {
    const combined = `${userText || ""} ${aiText || ""}`.toLowerCase();

    if (
        /प्रणाम|नमस्ते|चरण|पैर लागू|आशीर्वाद|खुश रहो|जीते रहो|सदा सुखी|भगवान|तरक्की|सफल|pranam|namaste|ashirwad|bless/.test(
            combined
        )
    ) {
        return "blessing";
    }

    if (/हाहा|हीही|हँस|हंस|मज़ाक|मजाक|चुटकुला|जोक|फनी|haha|joke|funny/.test(combined)) {
        return "laughing";
    }

    if (
        /तबीयत|खाना खाया|दवा|आराम|ध्यान रख|चिंता|परेशान|रो मत|हिम्मत|थक|नींद|बुखार|दर्द|ख्याल/.test(
            combined
        )
    ) {
        return "caring";
    }

    if (
        /शाबाश|बधाई|गर्व|बहुत बढ़िया|बहुत अच्छा|खुशी|मुस्कुरा|प्यार|सुंदर|अच्छा लग|वाह/.test(
            combined
        )
    ) {
        return "happy";
    }

    return "talking";
}

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

// ============================================================================
// 🔄 SELF-UPDATING GEMINI MODEL AUTO-DISCOVERY ENGINE (Never needs manual updates!)
// ============================================================================
function scoreGeminiModelForChat(modelId) {
    const id = modelId.toLowerCase();
    // Exclude specialized non-chat or retired models
    if (
        /embedding|imagen|veo|tts|transcribe|live|decision|cyber|banana|image|audio|aqa|bison|gecko|gemma|1\.0|1\.5|2\.0|2\.5|3\.5-flash$|3\.7-flash/.test(
            id
        )
    ) {
        return -1;
    }
    if (!id.startsWith("gemini-")) return -1;

    // Extract version number dynamically (e.g. gemini-5.0-flash -> 5.0, gemini-4-hydrogen -> 4.0, gemini-3.8-flash -> 3.8)
    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)/);
    const versionNum = verMatch ? parseFloat(verMatch[1]) : 3.0;

    let score = versionNum * 100;
    // Prefer flash-lite & flash first because they have the highest Free-Tier daily quota and lowest latency!
    if (id.includes("flash-lite")) score += 45;
    else if (id.includes("flash")) score += 35;
    else if (id.includes("hydrogen") || id.includes("argon")) score += 25;
    else if (id.includes("carbon") || id.includes("pro")) score += 10;

    if (id.includes("preview") || id.includes("exp")) score -= 15;
    return score;
}

async function getAutoUpdatedGeminiModelsList(apiKey) {
    const SIX_HOURS = 6 * 60 * 60 * 1000;
    if (cachedDiscoveredModels && Date.now() - lastModelDiscoveryTime < SIX_HOURS) {
        return cachedDiscoveredModels;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
            { signal: controller.signal }
        );
        clearTimeout(timer);

        if (res.ok) {
            const data = await res.json();
            const rawModels = Array.isArray(data.models) ? data.models : [];
            const scored = [];

            for (const m of rawModels) {
                const methods = Array.isArray(m.supportedGenerationMethods)
                    ? m.supportedGenerationMethods
                    : [];
                if (!methods.includes("generateContent")) continue;

                const shortId = String(m.name || "").replace(/^models\//, "");
                const sc = scoreGeminiModelForChat(shortId);
                if (sc > 0) {
                    scored.push({ id: shortId, score: sc });
                }
            }

            scored.sort((a, b) => b.score - a.score);
            const discoveredIds = scored.map((item) => item.id);

            // Merge live discovered models with our verified Nov 2026 active seed models
            const finalMerged = [];
            for (const id of [...discoveredIds, ...NOV_2026_ACTIVE_MODELS]) {
                if (!finalMerged.includes(id)) {
                    finalMerged.push(id);
                }
            }

            if (finalMerged.length > 0) {
                cachedDiscoveredModels = finalMerged.slice(0, 8);
                lastModelDiscoveryTime = Date.now();
                return cachedDiscoveredModels;
            }
        }
    } catch (_) {
        clearTimeout(timer);
    }

    return NOV_2026_ACTIVE_MODELS;
}

// ============================================================================
// 🎙️ 4 VOICE IDs + 20 CARTESIA KEYS PARSER & SMART AUTO-PAIRING POOL
// ============================================================================
function getAllCartesiaVoicesFromEnv() {
    const voices = [];
    const addVoice = (rawId) => {
        if (!rawId) return;
        String(rawId)
            .split(/[\s,;]+/)
            .forEach((part) => {
                const clean = part.replace(/["']/g, "").trim();
                if (clean && clean.length > 10 && !voices.some((v) => v.id === clean)) {
                    voices.push({ id: clean, num: voices.length + 1 });
                }
            });
    };

    for (let i = 1; i <= 10; i++) {
        addVoice(process.env[`CARTESIA_VOICE_ID_${i}`]);
        addVoice(process.env[`VOICE_ID_${i}`]);
    }
    addVoice(process.env.CARTESIA_VOICE_IDS);

    addVoice("5f2590b0-c99c-4fd8-97c8-56d5d3a621d8");
    addVoice("35bece76-689b-4b28-b398-0b53a8d5fd05");

    return voices;
}

function getCartesiaPoolFromEnv() {
    const allVoices = getAllCartesiaVoicesFromEnv();
    const pool = [];

    const addKeysForPreferredVoiceIndex = (rawKeysString, preferredVoiceZeroIdx) => {
        if (!rawKeysString) return;
        const preferredVoiceObj = allVoices[preferredVoiceZeroIdx] || allVoices[0];

        const orderedVoices = [
            preferredVoiceObj,
            ...allVoices.filter((v) => v.id !== preferredVoiceObj.id)
        ];

        String(rawKeysString)
            .split(/[\s,;]+/)
            .forEach((k) => {
                const clean = k.replace(/["']/g, "").trim();
                if (
                    clean &&
                    clean.length > 10 &&
                    !clean.startsWith("sk_car_admin_") &&
                    !pool.some((item) => item.key === clean)
                ) {
                    pool.push({
                        key: clean,
                        candidateVoices: orderedVoices
                    });
                }
            });
    };

    for (let v = 1; v <= 10; v++) {
        addKeysForPreferredVoiceIndex(process.env[`CARTESIA_KEYS_V${v}`], v - 1);
    }

    addKeysForPreferredVoiceIndex(process.env.CARTESIA_KEYS, 0);
    addKeysForPreferredVoiceIndex(process.env.CARTESIA_API_KEYS, 0);

    for (let i = 1; i <= 30; i++) {
        const rawKey = process.env[`CARTESIA_KEY_${i}`] || process.env[`CARTESIA_API_KEY_${i}`];
        if (rawKey) {
            const guessedVoiceIdx = Math.min(Math.floor((i - 1) / 5), allVoices.length - 1);
            addKeysForPreferredVoiceIndex(rawKey, guessedVoiceIdx);
        }
    }

    return { pool, allVoices };
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

async function tryKeyAcrossAllVoices(entry, text) {
    const lockedVoice = keyVoiceLockCache.get(entry.key);
    const voicesToTest = lockedVoice
        ? [lockedVoice, ...entry.candidateVoices.filter((v) => v.id !== lockedVoice.id)]
        : entry.candidateVoices;

    let lastRes = { ok: false, status: 0, error: "No voices tested" };

    for (const vObj of voicesToTest) {
        const res = await callSingleCartesiaTTS(entry.key, vObj.id, text);
        if (res.ok) {
            keyVoiceLockCache.set(entry.key, vObj);
            return {
                ok: true,
                audioBase64: res.audioBase64,
                modelUsed: res.modelUsed,
                voiceNum: vObj.num
            };
        }

        lastRes = { ...res, voiceNum: vObj.num };

        if (res.status === 404) {
            continue;
        }
        if (res.status === 401 || res.status === 402 || res.status === 429) {
            break;
        }
    }

    return lastRes;
}

function formatHistoryContextText(chatHistory) {
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return "";
    const recent = chatHistory.slice(-6);
    const lines = recent.map((turn) => {
        const speaker = turn.role === "papa" ? "Papa" : "Family Member";
        return `${speaker}: "${turn.text}"`;
    });
    return "RECENT LIVE CALL CONVERSATION HISTORY:\n" + lines.join("\n") + "\n\n";
}

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

async function generateGeminiReplyInternal(body) {
    const geminiKeys = getGeminiKeysFromEnv();
    const userText = body.userText || "नमस्ते पापा";
    const base64Frame = body.base64Frame || null;
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
    const skippedTelemetry = [];

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

    let lastError = "No Gemini keys configured";

    if (geminiKeys.length > 0) {
        if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;

        // Automatically discover the latest active Gemini models from Google's API!
        const modelsToTry = await getAutoUpdatedGeminiModelsList(geminiKeys[geminiKeyIdx]);

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
                        const finalReply = ensureCompleteHindiSentence(combinedText);
                        return {
                            aiText: finalReply,
                            emotion: detectPapaEmotion(userText, finalReply),
                            geminiKeyUsed: keyNum,
                            modelUsed: modelName,
                            skippedTelemetry
                        };
                    }

                    lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;
                    skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> HTTP ${gRes.status}`);

                    // If 404 (Deprecated/Retired), cooldown for 6 hours; if 429 (Quota), cooldown for 20 mins
                    if (gRes.status === 404) {
                        exhaustedModelCache.set(cacheKey, Date.now() + 6 * 60 * 60 * 1000);
                        continue;
                    }
                    if (gRes.status === 429 || gRes.status === 400) {
                        exhaustedModelCache.set(cacheKey, Date.now() + 20 * 60 * 1000);
                        continue;
                    }

                    if (gRes.status === 401 || gRes.status === 403) {
                        break;
                    }
                } catch (err) {
                    clearTimeout(timer);
                    lastError = err.message;
                    skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> ${err.message}`);
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
        backupReply.emotion = detectPapaEmotion(userText, backupReply.aiText);
        backupReply.skippedTelemetry = skippedTelemetry;
        return backupReply;
    }

    throw new Error(`Gemini API Error (${geminiKeys.length} keys tried): ${lastError}`);
}

async function generateTtsAudioInternal(rawText) {
    const text = ensureCompleteHindiSentence(rawText);
    const { pool: cartesiaPool } = getCartesiaPoolFromEnv();
    const renderUrl = (process.env.RENDER_TTS_URL || "https://papa-voice-cloud.onrender.com/api/tts").trim();
    let lastCartesiaError = "No Cartesia keys configured";

    if (cartesiaPool.length > 0) {
        if (cartesiaKeyIdx >= cartesiaPool.length) cartesiaKeyIdx = 0;

        for (let attempt = 0; attempt < cartesiaPool.length; attempt++) {
            const entry = cartesiaPool[cartesiaKeyIdx];
            const keyNum = cartesiaKeyIdx + 1;

            const result = await tryKeyAcrossAllVoices(entry, text);
            if (result.ok) {
                return {
                    audioBase64: result.audioBase64,
                    engineLabel: `Cartesia Key #${keyNum}/${cartesiaPool.length} (Voice #${result.voiceNum} - ${result.modelUsed})`
                };
            }

            lastCartesiaError = `Key #${keyNum} V#${result.voiceNum || 1} [${result.status}]: ${result.error}`;

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

    const startTimeMs = Date.now();
    const body = req.body || {};
    const action = body.action || "";
    const requiredPin = (process.env.APP_PIN || "1234").trim();

    if (action === "verify_pin") {
        const enteredPin = String(body.pin || "").trim();
        if (enteredPin === requiredPin) {
            const gKeys = getGeminiKeysFromEnv();
            const discovered = gKeys.length > 0 ? await getAutoUpdatedGeminiModelsList(gKeys[0]) : NOV_2026_ACTIVE_MODELS;
            return res.status(200).json({
                ok: true,
                releaseBaseUrl: getNormalizedReleaseBaseUrl(),
                autoDiscoveredModels: discovered.slice(0, 5)
            });
        }
        return res.status(401).json({ ok: false, error: "Wrong PIN" });
    }

    if (String(body.pin || "").trim() !== requiredPin) {
        return res.status(401).json({ error: "Unauthorized PIN" });
    }

    if (action === "chat_and_tts") {
        try {
            const t0 = Date.now();
            const chatResult = await generateGeminiReplyInternal(body);
            const geminiMs = Date.now() - t0;

            const t1 = Date.now();
            const ttsResult = await generateTtsAudioInternal(chatResult.aiText);
            const ttsMs = Date.now() - t1;

            return res.status(200).json({
                aiText: chatResult.aiText,
                emotion: chatResult.emotion || "talking",
                geminiKeyUsed: chatResult.geminiKeyUsed,
                modelUsed: chatResult.modelUsed,
                audioBase64: ttsResult.audioBase64,
                engineLabel: `G-Key #${chatResult.geminiKeyUsed} (${chatResult.modelUsed}) | ${ttsResult.engineLabel}`,
                telemetry: {
                    totalMs: Date.now() - startTimeMs,
                    geminiMs,
                    ttsMs,
                    skippedAttempts: chatResult.skippedTelemetry || []
                }
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
            return res.status(200).json({
                ...ttsResult,
                emotion: detectPapaEmotion("", text)
            });
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }

    if (action === "diag") {
        const geminiKeys = getGeminiKeysFromEnv();
        const { pool: cartesiaPool, allVoices } = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        const liveModels = geminiKeys.length > 0
            ? await getAutoUpdatedGeminiModelsList(geminiKeys[0])
            : NOV_2026_ACTIVE_MODELS;

        logs.push(`🔄 AUTO-DISCOVERED LIVE GEMINI MODELS: ${liveModels.slice(0, 5).join(", ")}`);
        logs.push(`🧠 GEMINI KEYS FOUND: ${geminiKeys.length}`);

        for (let g = 0; g < geminiKeys.length; g++) {
            const gKey = geminiKeys[g];
            const masked = gKey.slice(0, 6) + "..." + gKey.slice(-4);
            let keyWorked = false;
            let lastGStatus = "";

            for (const testModel of liveModels.slice(0, 4)) {
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

        logs.push(`\n🎙️ CARTESIA VOICES FOUND: ${allVoices.length} | KEYS FOUND: ${cartesiaPool.length}`);
        for (let k = 0; k < cartesiaPool.length; k++) {
            const entry = cartesiaPool[k];
            const maskedKey = entry.key.slice(0, 9) + "..." + entry.key.slice(-4);
            const resTest = await tryKeyAcrossAllVoices(
                entry,
                "नमस्ते बेटा, सदा खुश रहो, मेरा आशीर्वाद हमेशा तुम्हारे साथ है।"
            );
            if (resTest.ok) {
                logs.push(`✅ Key #${k + 1} (${maskedKey}) ➔ Matched Voice #${resTest.voiceNum} (${resTest.modelUsed}): SUCCESS!`);
                if (!firstSuccessAudio) {
                    firstSuccessAudio = resTest.audioBase64;
                    cartesiaKeyIdx = k;
                    activeKeyLabel = `Gemini (${geminiKeys.length} Keys) + Cartesia Key #${k + 1}/${cartesiaPool.length} (Voice #${resTest.voiceNum})`;
                }
            } else {
                logs.push(`❌ Key #${k + 1} (${maskedKey}): HTTP ${resTest.status} - ${resTest.error}`);
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
