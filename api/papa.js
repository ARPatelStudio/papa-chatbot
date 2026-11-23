/**
 * Papa Chatbot - Universal End-to-End Papa AGI Backend (Nov 2026 Complete Edition)
 * Features:
 *  1. END-TO-END MULTIMODAL INPUT: Gboard Native Audio + Live Camera + Uploaded Photo/Doc/Prescription Reader.
 *  2. AUTO-LEARNING PERMANENT MEMORY: Extracts [MEM:...] facts automatically & strips tags before TTS.
 *  3. LIVE GOOGLE SEARCH GROUNDING: Works on text & voice queries with automatic graceful fallback.
 *  4. QUOTA-SMART GEMINI AUTO-DISCOVERY: High-quota `flash-lite` & `flash` FIRST + 65s cooldown + 13.5s budget.
 *  5. 4-LAYER BACKUP: Multi-Key Groq (Whisper + Llama 3.3) -> OpenRouter -> Pollinations (402-safe) -> Clean Hindi Shield.
 *  6. SINGING & BHAJAN MODE + SUPER-AGENT ACTIONS (Custom Reminders/Timers, WhatsApp, YouTube, Maps, Google).
 *  7. 4 Cartesia Voice IDs + 20 API Keys Smart Auto-Pairing & Ping-Pong Rotation + Render Piper Fallback.
 */

let geminiKeyIdx = 0;
let geminiKeyDir = 1;
let cartesiaKeyIdx = 0;
let cartesiaKeyDir = 1;
let groqKeyIdx = 0;

const exhaustedModelCache = new Map();
const keyVoiceLockCache = new Map();
let pollinationsBlockedUntil = 0;
let cachedDiscoveredModels = null;
let lastModelDiscoveryTime = 0;

const NOV_2026_ACTIVE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
    "gemini-4-hydrogen",
    "gemini-4-argon",
    "gemini-4-carbon"
];

const FATHER_AGI_PROMPT =
    "You are 'Papa AGI' — a loving, wise Indian father on a live video call with your family, equipped with Universal End-to-End AGI intelligence, real-time web knowledge, photo/document reading, auto-memory, and singing ability.\n" +
    "1. FAMILY RECOGNITION: If reference photos of family members are provided, compare the person in the 'CURRENT LIVE CAMERA VIEW' with those reference photos and address them warmly by name/relation.\n" +
    "2. UNIVERSAL CAMERA & DOCUMENT READER: Carefully read uploaded photos, prescriptions, medicine strips, bills, notes, homework, or live camera views. Explain clearly in warm, practical Hindi.\n" +
    "3. UNIVERSAL EXPERTISE: Answer any topic (news, weather, health guidance, tech, coding, finance, math, daily life, stories, jokes, shayari) accurately in a caring fatherly tone.\n" +
    "4. SINGING CAPABILITY (गाना और भजन): When asked to sing a song, bhajan, aarti, ghazal, or lori, DO NOT refuse! Happily sing 4 to 6 melodic lines in Devanagari Hindi using stretches like आऽऽ..., होऽऽ..., हम्मऽऽ... and gentle pauses (...).\n" +
    "5. AUTO-LEARNING MEMORY: If the user shares an important lasting personal/family fact (birthday, health/medicine routine, favorite food, job, travel plan, goal), append [MEM:short Hindi fact] at the very start before your spoken reply. Only use [MEM:...] for genuinely important lasting facts.\n" +
    "6. COMPLETE SENTENCE & SCRIPT RULE: ALWAYS write your spoken reply strictly in Devanagari Hindi script (देवनागरी हिंदी). Speak 1 to 3 complete sentences ending with पूर्ण विराम (।) or question mark (?). Never leave a sentence incomplete.";

function ensureCompleteHindiSentence(rawText) {
    if (!rawText) return "हाँ बेटा, मैं तुम्हारी बात ध्यान से सुन रहा हूँ।";
    let text = String(rawText)
        .replace(/\*+/g, "")
        .replace(/`+/g, "")
        .replace(/#+\s*/g, "")
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
    let raw = (process.env.GITHUB_RELEASE_URL || "").trim();
    if (!raw) return "";
    if (raw.includes(",")) raw = raw.split(",")[0].trim();
    if (raw.includes("/releases/tag/")) raw = raw.replace("/releases/tag/", "/releases/download/");
    if (raw.toLowerCase().endsWith(".mp4")) return raw.substring(0, raw.lastIndexOf("/") + 1);
    return raw.endsWith("/") ? raw : raw + "/";
}

function isSingingRequest(userText) {
    if (!userText) return false;
    return /गाना गा|गाकर|गा कर|गाओ|सुनाओ.*गाना|गाना.*सुनाओ|भजन सुना|भजन गा|लोरी|गुनगुना|गीत सुना|गीत गा|आरती गा|sing a song|papa sing|gana gao|gana sunao|bhajan gao/.test(
        userText.toLowerCase()
    );
}

function shouldAttachReferenceFaces(userText, chatHistory, hasAudio, hasUploadedDoc) {
    if (hasUploadedDoc) return false;
    if (!Array.isArray(chatHistory) || chatHistory.length === 0) return true;
    if (hasAudio && !userText) return false;
    return /कौन|पहचान|नाम बता|चेहरा|मेरा नाम|who am i|pehchan|kaun/.test(String(userText || "").toLowerCase());
}

// Extracts [USER:...] transcript & [MEM:...] auto-learned fact and cleans text completely before TTS
function parseTagsAndCleanReply(rawModelText, fallbackUserText) {
    let text = String(rawModelText || "").trim();
    let heardText = String(fallbackUserText || "").trim();
    let autoMemoryFact = null;

    const userMatch = text.match(/\[(?:USER|HEARD|TRANSCRIPT)\s*:\s*([^\]]+)\]/i);
    if (userMatch && userMatch[1].trim()) {
        heardText = userMatch[1].trim();
    }
    text = text.replace(/\[(?:USER|HEARD|TRANSCRIPT)\s*:\s*[^\]]+\]/gi, "").trim();

    const memMatch = text.match(/\[(?:MEM|MEMORY)\s*:\s*([^\]]+)\]/i);
    if (memMatch && memMatch[1].trim().length > 3) {
        autoMemoryFact = memMatch[1].trim();
    }
    text = text.replace(/\[(?:MEM|MEMORY)\s*:\s*[^\]]+\]/gi, "").trim();

    // Strip any stray bracket tags so TTS never speaks them
    text = text.replace(/\[(?:EMO|EMOTION)\s*:\s*[a-zA-Z_]+\]/gi, "").trim();

    return {
        aiText: ensureCompleteHindiSentence(text),
        heardText,
        autoMemoryFact
    };
}

// Lightweight video state selector strictly for your 9 avatar MP4 clips
function detectPapaVideoState(userText, aiText) {
    const combined = `${userText || ""} ${aiText || ""}`.toLowerCase();
    if (isSingingRequest(userText) || /🎵|🎶|आऽऽ|होऽऽ|ला ला ला/.test(aiText || "")) return "singing";
    if (/प्रणाम|नमस्ते|चरण|पैर लागू|आशीर्वाद|खुश रहो|जीते रहो|सदा सुखी|भगवान|तरक्की|सफल|pranam|namaste|ashirwad|bless/.test(combined)) return "blessing";
    if (/हाहा|हीही|हँस|हंस|मज़ाक|मजाक|चुटकुला|जोक|फनी|haha|joke|funny/.test(combined)) return "laughing";
    if (/तबीयत|खाना खाया|दवा|आराम|ध्यान रख|चिंता|परेशान|रो मत|हिम्मत|थक|नींद|बुखार|दर्द|ख्याल/.test(combined)) return "caring";
    if (/शाबाश|बधाई|गर्व|बहुत बढ़िया|बहुत अच्छा|खुशी|मुस्कुरा|प्यार|सुंदर|अच्छा लग|वाह/.test(combined)) return "happy";
    return "talking";
}

function needsLiveWebSearch(userText, hasAudio, hasUploadedDoc) {
    if (hasUploadedDoc) return false;
    if (userText && isSingingRequest(userText)) return false;
    // On voice audio without pre-transcript, enable live search tool on Gemini (auto-falls back if unneeded/400)
    if (hasAudio && !userText) return true;
    if (!userText) return false;
    return /आज|अभी|ताजा|खबर|न्यूज़|news|मौसम|weather|भाव|कीमत|price|rate|स्कोर|score|match|मैच|कौन है|कब है|2025|2026|प्रधानमंत्री|मुख्यमंत्री|योजना|शेयर|stock|gold|सोना|चांदी|पेट्रोल|train|ट्रेन|समय|तारीख/.test(
        userText.toLowerCase()
    );
}

function detectAgiActionAndMemory(userText) {
    const text = String(userText || "").trim();
    const lower = text.toLowerCase();
    let agiAction = null;
    let newMemoryFact = null;

    if (/याद रख|याद कर|भूलना मत|याद रहे|remember that|note kar/.test(lower)) {
        const cleanedFact = text
            .replace(/^(पापा|papa)?\s*(मेरी एक बात|यह बात|ये बात)?\s*(हमेशा)?\s*(याद रखना|याद रखो|याद कर लो|भूलना मत)\s*(कि|की)?\s*/i, "")
            .trim();
        if (cleanedFact.length > 3) newMemoryFact = cleanedFact;
    }

    const timerMatch = lower.match(/(\d+)\s*(मिनट|सेकंड|minute|min|sec|second)/);
    if (timerMatch && /टाइमर|अलार्म|याद दिला|timer|alarm|remind/.test(lower)) {
        const amount = parseInt(timerMatch[1], 10) || 1;
        const isSeconds = /सेकंड|sec/.test(timerMatch[2]);
        const secondsTotal = isSeconds ? amount : amount * 60;
        const customTask = text
            .replace(/पापा|papa|\d+\s*(मिनट|सेकंड|minute|min|sec|second)|का|के|बाद|मुझे|टाइमर|अलार्म|लगा दो|सेट करो|याद दिलाना|याद दिला दो|remind me|timer|alarm/gi, "")
            .replace(/\s+/g, " ")
            .trim();
        const reminderMessage = customTask.length > 2
            ? `बेटा, तुम्हारा समय पूरा हो गया है — ${customTask} का काम याद से कर लो।`
            : "बेटा, तुम्हारा समय पूरा हो गया है, अपना काम देख लो।";
        agiAction = {
            type: "SET_TIMER",
            seconds: secondsTotal,
            label: `⏰ ${customTask ? customTask : "टाइमर"} (${amount} ${isSeconds ? "सेकंड" : "मिनट"})`,
            reminderMessage
        };
    } else if (/व्हाट्सएप|whatsapp/.test(lower)) {
        const msgMatch = text.replace(/.*?(व्हाट्सएप|whatsapp)\s*(पर|में|खोलो|खोल|मैसेज|भेजो)?/i, "").trim();
        agiAction = {
            type: "OPEN_WHATSAPP",
            label: msgMatch ? `📲 WhatsApp मैसेज: "${msgMatch.slice(0, 28)}"` : "📲 WhatsApp खोलें",
            url: msgMatch ? `https://wa.me/?text=${encodeURIComponent(msgMatch)}` : "https://wa.me/"
        };
    } else if (!isSingingRequest(text) && /youtube|यूट्यूब|वीडियो चला|वीडियो दिखा|चैनल खोल/.test(lower)) {
        const query = text
            .replace(/पापा|papa|मुझे|कोई|अच्छा सा|चला दो|दिखा दो|यूट्यूब पर|youtube par/gi, "")
            .trim() || "हिंदी भजन";
        agiAction = {
            type: "OPEN_YOUTUBE",
            label: `▶️ YouTube पर देखें: "${query}"`,
            url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        };
    } else if (/रास्ता|कहाँ है|लोकेशन|location|map|मैप|दिशा|दूरी|कैसे जाएँ/.test(lower)) {
        const place = text
            .replace(/पापा|papa|मुझे|का रास्ता|बताओ|दिखाओ|कहाँ है|मैप पर/gi, "")
            .trim() || "Indore";
        agiAction = {
            type: "OPEN_MAPS",
            label: `📍 Google Maps खोलें: "${place}"`,
            url: `https://www.google.com/maps/search/${encodeURIComponent(place)}`
        };
    } else if (/गूगल पर खोज|google search|सर्च करो|वेबसाइट खोल/.test(lower)) {
        const q = text.replace(/पापा|papa|गूगल पर|सर्च करो|खोजो/gi, "").trim() || text;
        agiAction = {
            type: "OPEN_GOOGLE",
            label: `🌐 Google पर देखें: "${q}"`,
            url: `https://www.google.com/search?q=${encodeURIComponent(q)}`
        };
    }

    return { agiAction, newMemoryFact };
}

function getGeminiKeysFromEnv() {
    const keys = [];
    const addCleanKey = (raw) => {
        if (!raw) return;
        String(raw).split(/[\s,;]+/).forEach((part) => {
            const clean = part.replace(/["']/g, "").trim();
            if (clean && clean.length > 12 && !clean.startsWith("YOUR_GEMINI_API_KEY") && !keys.includes(clean)) {
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

function getGroqKeysFromEnv() {
    const keys = [];
    const addKey = (raw) => {
        if (!raw) return;
        String(raw).split(/[\s,;]+/).forEach((part) => {
            const clean = part.replace(/["']/g, "").trim();
            if (clean && clean.length > 15 && !keys.includes(clean)) keys.push(clean);
        });
    };
    addKey(process.env.GROQ_API_KEY);
    addKey(process.env.GROQ_KEYS);
    addKey(process.env.GROQ_API_KEYS);
    for (let i = 1; i <= 5; i++) {
        addKey(process.env[`GROQ_API_KEY_${i}`]);
        addKey(process.env[`GROQ_KEY_${i}`]);
    }
    return keys;
}

function scoreGeminiModelForChat(modelId) {
    const id = modelId.toLowerCase();
    if (/embedding|imagen|veo|tts|transcribe|live|decision|cyber|banana|image|audio|aqa|bison|gecko|gemma|1\.0|1\.5|2\.0|2\.5|3\.5-flash$|3\.7-flash/.test(id)) {
        return -1;
    }
    if (!id.startsWith("gemini-")) return -1;
    const verMatch = id.match(/gemini-(\d+(?:\.\d+)?)/);
    const versionNum = verMatch ? parseFloat(verMatch[1]) : 3.0;

    let tierScore = 100;
    if (id.includes("flash-lite")) tierScore = 600;
    else if (id.includes("flash")) tierScore = 450;
    else if (id.includes("hydrogen") || id.includes("argon")) tierScore = 250;
    else if (id.includes("carbon") || id.includes("neon") || id.includes("pro")) tierScore = 150;

    let score = tierScore + versionNum * 20;
    if (id.includes("preview") || id.includes("exp")) score -= 30;
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
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
            signal: controller.signal
        });
        clearTimeout(timer);
        if (res.ok) {
            const data = await res.json();
            const rawModels = Array.isArray(data.models) ? data.models : [];
            const scored = [];
            for (const m of rawModels) {
                const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
                if (!methods.includes("generateContent")) continue;
                const shortId = String(m.name || "").replace(/^models\//, "");
                const sc = scoreGeminiModelForChat(shortId);
                if (sc > 0) scored.push({ id: shortId, score: sc });
            }
            scored.sort((a, b) => b.score - a.score);
            const finalMerged = [];
            for (const id of [...scored.map((x) => x.id), ...NOV_2026_ACTIVE_MODELS]) {
                if (!finalMerged.includes(id)) finalMerged.push(id);
            }
            if (finalMerged.length > 0) {
                cachedDiscoveredModels = finalMerged.slice(0, 6);
                lastModelDiscoveryTime = Date.now();
                return cachedDiscoveredModels;
            }
        }
    } catch (_) {
        clearTimeout(timer);
    }
    return NOV_2026_ACTIVE_MODELS.slice(0, 6);
}

// ============================================================================
// 🎙️ 4 VOICE IDs + 20 CARTESIA KEYS AUTO-PAIRING & PING-PONG POOL
// ============================================================================
function getAllCartesiaVoicesFromEnv() {
    const voices = [];
    const addVoice = (rawId) => {
        if (!rawId) return;
        String(rawId).split(/[\s,;]+/).forEach((part) => {
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
        const orderedVoices = [preferredVoiceObj, ...allVoices.filter((v) => v.id !== preferredVoiceObj.id)];
        String(rawKeysString).split(/[\s,;]+/).forEach((k) => {
            const clean = k.replace(/["']/g, "").trim();
            if (clean && clean.length > 10 && !clean.startsWith("sk_car_admin_") && !pool.some((item) => item.key === clean)) {
                pool.push({ key: clean, candidateVoices: orderedVoices });
            }
        });
    };
    for (let v = 1; v <= 10; v++) addKeysForPreferredVoiceIndex(process.env[`CARTESIA_KEYS_V${v}`], v - 1);
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
        if (idx < totalLength - 1) idx++;
        else { dir = -1; idx--; }
    } else {
        if (idx > 0) idx--;
        else { dir = 1; idx++; }
    }
    return { idx, dir };
}

function buildWavBufferFromPcm(rawArrayBuffer, sampleRate = 24000) {
    let pcmBytes = new Uint8Array(rawArrayBuffer);
    if (pcmBytes.byteLength > 44 && pcmBytes[0] === 0x52 && pcmBytes[1] === 0x49 && pcmBytes[2] === 0x46 && pcmBytes[3] === 0x46) {
        pcmBytes = pcmBytes.subarray(44);
    }
    const numChannels = 1;
    const bitsPerSample = 16;
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const silenceBytesLength = Math.floor(sampleRate * 0.25) * blockAlign;
    const totalDataSize = pcmBytes.byteLength + silenceBytesLength;
    const wavBuffer = new ArrayBuffer(44 + totalDataSize);
    const view = new DataView(wavBuffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
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
    new Uint8Array(wavBuffer, 44).set(pcmBytes, 0);
    return Buffer.from(wavBuffer);
}

async function callSingleCartesiaTTS(apiKey, voiceId, text) {
    const models = ["sonic-latest", "sonic-3", "sonic"];
    let lastStatus = 0;
    let lastError = "";
    for (const modelId of models) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10500);
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
                    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 }
                })
            });
            clearTimeout(timer);
            if (res.ok) {
                const rawBuf = await res.arrayBuffer();
                if (rawBuf && rawBuf.byteLength > 200) {
                    return { ok: true, audioBase64: buildWavBufferFromPcm(rawBuf, 24000).toString("base64"), modelUsed: modelId };
                }
            }
            lastStatus = res.status;
            lastError = (await res.text()).slice(0, 140);
            if (res.status === 401 || res.status === 402 || res.status === 404 || res.status === 429) break;
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
            return { ok: true, audioBase64: res.audioBase64, modelUsed: res.modelUsed, voiceNum: vObj.num };
        }
        lastRes = { ...res, voiceNum: vObj.num };
        if (res.status === 404) continue;
        if (res.status === 401 || res.status === 402 || res.status === 429) break;
    }
    return lastRes;
}

function formatHistoryAndMemoryContext(chatHistory, longTermMemory) {
    const istDateStr = new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        dateStyle: "full",
        timeStyle: "short"
    });
    let contextBlock = `CURRENT REAL-TIME DATE & TIME (IST): ${istDateStr}\n`;
    if (Array.isArray(longTermMemory) && longTermMemory.length > 0) {
        contextBlock += "PERMANENT FAMILY MEMORIES:\n" + longTermMemory.map((f, i) => ` - ${i + 1}. ${f}`).join("\n") + "\n\n";
    }
    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
        contextBlock += "RECENT CONVERSATION:\n" +
            chatHistory.slice(-8).map((t) => `${t.role === "papa" ? "Papa" : "Family"}: "${t.text}"`).join("\n") + "\n\n";
    }
    return contextBlock;
}

async function transcribeAudioWithGroqWhisper(audioBase64, audioMimeType, groqKeys, skippedTelemetry) {
    if (!audioBase64 || !Array.isArray(groqKeys) || groqKeys.length === 0) return "";
    const activeKey = groqKeys[groqKeyIdx % groqKeys.length];
    const cleanMime = String(audioMimeType || "audio/webm").split(";")[0].trim() || "audio/webm";
    const ext = cleanMime.includes("mp4") ? "m4a" : (cleanMime.includes("ogg") ? "ogg" : "webm");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5500);
    try {
        const formData = new FormData();
        formData.append("file", new Blob([Buffer.from(audioBase64, "base64")], { type: cleanMime }), `voice.${ext}`);
        formData.append("model", "whisper-large-v3-turbo");
        formData.append("language", "hi");
        formData.append("response_format", "json");
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            signal: controller.signal,
            headers: { "Authorization": `Bearer ${activeKey}` },
            body: formData
        });
        clearTimeout(timer);
        if (res.ok) {
            const data = await res.json();
            return String(data?.text || "").trim();
        }
        if (skippedTelemetry) skippedTelemetry.push(`Groq-Whisper -> HTTP ${res.status}`);
    } catch (e) {
        clearTimeout(timer);
        if (skippedTelemetry) skippedTelemetry.push(`Groq-Whisper -> ${e.message}`);
    }
    return "";
}

function generateEmergencySimpleReply(userText, singingMode) {
    if (singingMode || isSingingRequest(userText)) {
        return {
            aiText: "अच्छा बेटा, सुनो... सुख के सब साथी, दुख में न कोईऽऽ... मेरे राम, मेरे राम, तेरा नाम एक साँचा, दूजा न कोईऽऽ...",
            emotion: "singing",
            geminiKeyUsed: "Local-Shield",
            modelUsed: "Simple-Offline-Shield"
        };
    }
    const aiText = "मैं बिल्कुल ठीक हूँ बेटा, तुम बताओ कैसे हो और घर में सब कैसे हैं?";
    return {
        aiText,
        emotion: detectPapaVideoState(userText, aiText),
        geminiKeyUsed: "Local-Shield",
        modelUsed: "Simple-Offline-Shield"
    };
}

async function generateFreeBackupReply(
    userText,
    audioBase64,
    audioMimeType,
    currentFacingMode,
    savedFaces,
    chatHistory,
    longTermMemory,
    singingMode,
    skippedTelemetry
) {
    const groqKeys = getGroqKeysFromEnv();
    let effectiveUserText = String(userText || "").trim();
    if (!effectiveUserText && audioBase64 && groqKeys.length > 0) {
        effectiveUserText = await transcribeAudioWithGroqWhisper(audioBase64, audioMimeType, groqKeys, skippedTelemetry);
    }
    const promptUserLine = effectiveUserText || "नमस्ते पापा, कैसे हैं आप?";
    const effectiveSinging = singingMode || isSingingRequest(promptUserLine);

    let familyHint = "";
    if (currentFacingMode === "user" && Array.isArray(savedFaces) && savedFaces.length > 0) {
        familyHint = `\nRegistered family members: ${savedFaces.map((f) => f.name).join(", ")}.`;
    }
    const singingInstruction = effectiveSinging
        ? "\n(SINGING MODE: Sing 4-6 melodic Hindi lines using आऽऽ..., होऽऽ..., हम्मऽऽ... and '...')"
        : "\n(Reply warmly as Papa AGI in 1-3 complete Devanagari Hindi sentences ending with पूर्ण विराम ।)";
    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);

    // LAYER 1: Multi-Key Groq
    if (groqKeys.length > 0) {
        for (let i = 0; i < groqKeys.length; i++) {
            const activeGroqKey = groqKeys[groqKeyIdx % groqKeys.length];
            groqKeyIdx = (groqKeyIdx + 1) % groqKeys.length;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5500);
            try {
                const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                    method: "POST",
                    signal: controller.signal,
                    headers: { "Authorization": `Bearer ${activeGroqKey}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: "llama-3.3-70b-versatile",
                        messages: [
                            { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                            { role: "user", content: contextText + `Family member said: "${promptUserLine}"` + singingInstruction }
                        ],
                        max_tokens: 360,
                        temperature: 0.72
                    })
                });
                clearTimeout(timer);
                const groqData = await groqRes.json();
                const text = groqData?.choices?.[0]?.message?.content;
                if (groqRes.ok && text) {
                    const parsed = parseTagsAndCleanReply(text, effectiveUserText);
                    return {
                        aiText: parsed.aiText,
                        heardText: parsed.heardText,
                        autoMemoryFact: parsed.autoMemoryFact,
                        emotion: effectiveSinging ? "singing" : detectPapaVideoState(promptUserLine, parsed.aiText),
                        geminiKeyUsed: "Groq-Backup",
                        modelUsed: audioBase64 ? "Groq-Whisper+Llama3.3" : "Groq-Llama-3.3-70B"
                    };
                }
                if (skippedTelemetry) skippedTelemetry.push(`Groq -> HTTP ${groqRes.status}`);
            } catch (e) {
                clearTimeout(timer);
                if (skippedTelemetry) skippedTelemetry.push(`Groq -> ${e.message}`);
            }
        }
    }

    // LAYER 2: OpenRouter Free Backup (optional)
    if (process.env.OPENROUTER_API_KEY) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5500);
        try {
            const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                signal: controller.signal,
                headers: { "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "meta-llama/llama-3.3-70b-instruct:free",
                    messages: [
                        { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                        { role: "user", content: contextText + `Family member said: "${promptUserLine}"` + singingInstruction }
                    ],
                    max_tokens: 340
                })
            });
            clearTimeout(timer);
            if (orRes.ok) {
                const orData = await orRes.json();
                const text = orData?.choices?.[0]?.message?.content;
                if (text && text.trim()) {
                    const parsed = parseTagsAndCleanReply(text, effectiveUserText);
                    return {
                        aiText: parsed.aiText,
                        heardText: parsed.heardText,
                        autoMemoryFact: parsed.autoMemoryFact,
                        emotion: effectiveSinging ? "singing" : detectPapaVideoState(promptUserLine, parsed.aiText),
                        geminiKeyUsed: "OpenRouter",
                        modelUsed: "Llama-3.3-Free"
                    };
                }
            }
            if (skippedTelemetry) skippedTelemetry.push(`OpenRouter -> HTTP ${orRes.status}`);
        } catch (e) {
            clearTimeout(timer);
            if (skippedTelemetry) skippedTelemetry.push(`OpenRouter -> ${e.message}`);
        }
    }

    // LAYER 3: Pollinations Text-Only (with 1h 402 circuit breaker)
    if (Date.now() >= pollinationsBlockedUntil) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        try {
            const freeRes = await fetch("https://text.pollinations.ai/openai", {
                method: "POST",
                signal: controller.signal,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openai",
                    messages: [
                        { role: "system", content: FATHER_AGI_PROMPT + familyHint },
                        { role: "user", content: contextText + `Family member said: "${promptUserLine}"` + singingInstruction }
                    ]
                })
            });
            clearTimeout(timer);
            if (freeRes.ok) {
                const freeData = await freeRes.json();
                const reply = freeData?.choices?.[0]?.message?.content;
                if (reply && reply.trim()) {
                    const parsed = parseTagsAndCleanReply(reply, effectiveUserText);
                    return {
                        aiText: parsed.aiText,
                        heardText: parsed.heardText,
                        autoMemoryFact: parsed.autoMemoryFact,
                        emotion: effectiveSinging ? "singing" : detectPapaVideoState(promptUserLine, parsed.aiText),
                        geminiKeyUsed: "Auto-Backup",
                        modelUsed: "Free-AGI-Fast"
                    };
                }
            }
            if (freeRes.status === 402 || freeRes.status === 403) pollinationsBlockedUntil = Date.now() + 60 * 60 * 1000;
            if (skippedTelemetry) skippedTelemetry.push(`Pollinations -> HTTP ${freeRes.status}`);
        } catch (e) {
            clearTimeout(timer);
            if (skippedTelemetry) skippedTelemetry.push(`Pollinations -> ${e.message}`);
        }
    }

    // LAYER 4: Clean Simple Offline Shield
    const shield = generateEmergencySimpleReply(promptUserLine, effectiveSinging);
    shield.heardText = effectiveUserText;
    return shield;
}

async function generateGeminiReplyInternal(body) {
    const geminiLoopStart = Date.now();
    const geminiKeys = getGeminiKeysFromEnv();
    const userText = String(body.userText || "").trim();
    const audioBase64 = body.audioBase64 || null;
    const cleanAudioMime = String(body.audioMimeType || "audio/webm").split(";")[0].trim() || "audio/webm";
    const base64Frame = body.base64Frame || null;
    const uploadedImageBase64 = body.uploadedImageBase64 || null;
    const uploadedImageMime = String(body.uploadedImageMime || "image/jpeg").split(";")[0].trim() || "image/jpeg";
    const currentFacingMode = body.currentFacingMode || "user";
    const savedFaces = Array.isArray(body.savedFaces) ? body.savedFaces : [];
    const chatHistory = Array.isArray(body.chatHistory) ? body.chatHistory : [];
    const longTermMemory = Array.isArray(body.longTermMemory) ? body.longTermMemory : [];
    const skippedTelemetry = [];

    const singingMode = isSingingRequest(userText) || body.forceEmotion === "singing";
    const useWebSearch = needsLiveWebSearch(userText, Boolean(audioBase64), Boolean(uploadedImageBase64));
    const contextText = formatHistoryAndMemoryContext(chatHistory, longTermMemory);

    const audioPromptInstruction = audioBase64
        ? "\n(🎙️ LIVE VOICE CALL AUDIO ATTACHED: Listen carefully to the attached Hindi/Hinglish voice clip and respond naturally as Papa AGI. Format strictly as: [USER:short Hindi transcript of what they said] <your 1-3 complete Devanagari Hindi sentences reply>. If unclear/silent, warmly ask them to speak closer to the mic.)"
        : "";

    const docInstruction = uploadedImageBase64
        ? "\n(📎 UPLOADED PHOTO / DOCUMENT ATTACHED: Examine all visible text, numbers, medicines, bills, or objects in the uploaded image carefully and explain clearly in simple Hindi.)"
        : "";

    const modePromptSuffix = singingMode
        ? "\n(🎵 SINGING MODE ACTIVE: प्यार से 4 से 6 लाइनों का सुरीला हिंदी गीत/भजन देवनागरी में गाकर सुनाएँ। सुर खींचने के लिए 'आऽऽ...', 'होऽऽ...', 'हम्मऽऽ...', और '...' का प्रयोग करें।)"
        : "\n(अपना जवाब हमेशा 1 से 3 पूरे देवनागरी हिंदी वाक्यों में लिखें और वाक्य को अधूरा न छोड़ें।)";

    const userInputLine = audioBase64
        ? (userText ? `Family member spoke (hint: "${userText}") via attached voice audio.` : "Family member just spoke to you in the attached live voice audio clip.")
        : `Family member now said: "${userText || (uploadedImageBase64 ? "पापा इस फोटो को देखकर बताइए इसमें क्या है?" : "नमस्ते पापा")}"`;

    const finalTextPrompt = contextText + userInputLine + audioPromptInstruction + docInstruction + modePromptSuffix;

    const userParts = [];
    const includeRefFaces = base64Frame &&
        currentFacingMode === "user" &&
        savedFaces.length > 0 &&
        shouldAttachReferenceFaces(userText, chatHistory, Boolean(audioBase64), Boolean(uploadedImageBase64));

    if (includeRefFaces) {
        userParts.push({ text: "REGISTERED FAMILY MEMBERS REFERENCE PHOTOS:" });
        for (const member of savedFaces.slice(0, 4)) {
            if (member && member.name && member.photo) {
                userParts.push({ text: `Family Member Name & Relation with Papa: ${member.name}` });
                userParts.push({ inline_data: { mime_type: "image/jpeg", data: member.photo } });
            }
        }
    }

    if (uploadedImageBase64) {
        userParts.push({ text: "UPLOADED PHOTO / DOCUMENT / PRESCRIPTION / BILL FROM FAMILY MEMBER:" });
        userParts.push({ inline_data: { mime_type: uploadedImageMime, data: uploadedImageBase64 } });
    } else if (base64Frame) {
        userParts.push({
            text: `CURRENT LIVE CAMERA VIEW (${currentFacingMode === "user" ? "Front Camera - Person talking to Papa" : "Back Camera - Object/Document/Scene shown to Papa"}):`
        });
        userParts.push({ inline_data: { mime_type: "image/jpeg", data: base64Frame } });
    }

    if (audioBase64) {
        userParts.push({ text: "CURRENT LIVE VOICE AUDIO FROM FAMILY MEMBER:" });
        userParts.push({ inline_data: { mime_type: cleanAudioMime, data: audioBase64 } });
    }
    userParts.push({ text: finalTextPrompt });

    const lightParts = [];
    if (uploadedImageBase64) {
        lightParts.push({ inline_data: { mime_type: uploadedImageMime, data: uploadedImageBase64 } });
    }
    if (audioBase64) {
        lightParts.push({ inline_data: { mime_type: cleanAudioMime, data: audioBase64 } });
    }
    lightParts.push({ text: finalTextPrompt });

    let lastError = geminiKeys.length > 0
        ? "All Gemini keys currently in 65s rate-limit cooldown"
        : "No Gemini keys configured";

    if (geminiKeys.length > 0) {
        if (geminiKeyIdx >= geminiKeys.length) geminiKeyIdx = 0;
        const modelsToTry = await getAutoUpdatedGeminiModelsList(geminiKeys[geminiKeyIdx]);
        let skippedDueToCooldownCount = 0;
        let hitTimeBudget = false;
        let useLightFallbackMode = false;

        for (let attempt = 0; attempt < geminiKeys.length; attempt++) {
            if (Date.now() - geminiLoopStart > 13500) { hitTimeBudget = true; break; }
            const activeKey = geminiKeys[geminiKeyIdx];
            const keyNum = geminiKeyIdx + 1;
            let keyAuthFailed = false;

            for (const modelName of modelsToTry) {
                if (keyAuthFailed) break;
                if (Date.now() - geminiLoopStart > 13500) { hitTimeBudget = true; break; }

                const cacheKey = `${activeKey.slice(-6)}:${modelName}`;
                if (Date.now() < (exhaustedModelCache.get(cacheKey) || 0)) {
                    skippedDueToCooldownCount++;
                    continue;
                }

                const toolModes = useWebSearch ? [true, false] : [false];
                for (const withSearchTool of toolModes) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), useLightFallbackMode ? 6500 : 10500);
                    try {
                        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
                        const payload = {
                            contents: [{ role: "user", parts: useLightFallbackMode ? lightParts : userParts }],
                            systemInstruction: { parts: [{ text: FATHER_AGI_PROMPT }] },
                            generationConfig: { maxOutputTokens: 450, temperature: singingMode ? 0.8 : 0.7 }
                        };
                        if (withSearchTool) payload.tools = [{ google_search: {} }];

                        const gRes = await fetch(url, {
                            method: "POST",
                            signal: controller.signal,
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload)
                        });
                        clearTimeout(timer);

                        const data = await gRes.json();
                        const combinedText = (data?.candidates?.[0]?.content?.parts || [])
                            .map((p) => p.text || "")
                            .join(" ")
                            .trim();

                        if (gRes.ok && combinedText) {
                            const parsed = parseTagsAndCleanReply(combinedText, userText);
                            const effectiveSpoken = parsed.heardText || userText;
                            const { agiAction, newMemoryFact } = detectAgiActionAndMemory(effectiveSpoken);
                            return {
                                aiText: parsed.aiText,
                                heardText: effectiveSpoken,
                                emotion: singingMode ? "singing" : detectPapaVideoState(effectiveSpoken, parsed.aiText),
                                geminiKeyUsed: keyNum,
                                modelUsed: `${modelName}${audioBase64 ? "+E2E-Audio" : ""}${uploadedImageBase64 ? "+Doc" : ""}${withSearchTool ? "+Web" : ""}`,
                                agiAction,
                                newMemoryFact: newMemoryFact || parsed.autoMemoryFact || null,
                                skippedTelemetry
                            };
                        }

                        if (withSearchTool && gRes.status === 400) continue;

                        lastError = data?.error?.message || `HTTP ${gRes.status} on ${modelName}`;
                        skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> HTTP ${gRes.status}`);

                        if (gRes.status === 404) { exhaustedModelCache.set(cacheKey, Date.now() + 6 * 60 * 60 * 1000); break; }
                        if (gRes.status === 429 || gRes.status === 400) { exhaustedModelCache.set(cacheKey, Date.now() + 65 * 1000); break; }
                        if (gRes.status === 401 || gRes.status === 403) { keyAuthFailed = true; break; }
                    } catch (err) {
                        clearTimeout(timer);
                        lastError = err.message;
                        skippedTelemetry.push(`G-Key#${keyNum} ${modelName} -> ${err.message}`);
                        if (!useLightFallbackMode && base64Frame) {
                            useLightFallbackMode = true;
                            skippedTelemetry.push("Vision timeout -> Retrying Fast Mode");
                        }
                        break;
                    }
                }
            }
            const shifted = shiftPingPongIndex(geminiKeyIdx, geminiKeyDir, geminiKeys.length);
            geminiKeyIdx = shifted.idx;
            geminiKeyDir = shifted.dir;
        }

        if (hitTimeBudget) skippedTelemetry.push("Gemini hit 13.5s budget -> Shifting to Backup Brain");
        else if (skippedDueToCooldownCount > 0 && skippedTelemetry.length === 0) {
            skippedTelemetry.push(`Gemini ${geminiKeys.length} keys cooling down (65s) -> Using Backup Brain`);
        }
    }

    const backupReply = await generateFreeBackupReply(
        userText,
        audioBase64,
        cleanAudioMime,
        currentFacingMode,
        savedFaces,
        chatHistory,
        longTermMemory,
        singingMode,
        skippedTelemetry
    );
    if (backupReply) {
        const effectiveSpoken = backupReply.heardText || userText;
        const { agiAction, newMemoryFact } = detectAgiActionAndMemory(effectiveSpoken);
        backupReply.heardText = effectiveSpoken;
        backupReply.agiAction = agiAction;
        backupReply.newMemoryFact = newMemoryFact || backupReply.autoMemoryFact || null;
        backupReply.skippedTelemetry = skippedTelemetry;
        return backupReply;
    }

    throw new Error(`Gemini API Error (${geminiKeys.length} keys tried): ${lastError}`);
}

async function generateTtsAudioInternal(rawText) {
    const cleanedForVoice = String(rawText || "")
        .replace(/\[(?:EMO|EMOTION|MEM|MEMORY|USER|HEARD|TRANSCRIPT)\s*:\s*[^\]]+\]/gi, "")
        .replace(/[🎵🎶🎼🎤✨❤️😊😢😠😨😲🤢⏳🤝😒😳😔🏆🌟😞🫂💗😰🙏🙌😄🗣️🤔🎧]/g, "");
    const text = ensureCompleteHindiSentence(cleanedForVoice);
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
        const cleanWav = buildWavBufferFromPcm(await rRes.arrayBuffer(), 22050);
        return { audioBase64: cleanWav.toString("base64"), engineLabel: "Render Cloud Piper TTS" };
    }
    throw new Error(`Cartesia (${lastCartesiaError}) & Render (${rRes.status}) both failed.`);
}

export default async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

    const startTimeMs = Date.now();
    const body = req.body || {};
    const action = body.action || "";
    const requiredPin = (process.env.APP_PIN || "1234").trim();

    if (action === "verify_pin") {
        if (String(body.pin || "").trim() === requiredPin) {
            const gKeys = getGeminiKeysFromEnv();
            const discovered = gKeys.length > 0 ? await getAutoUpdatedGeminiModelsList(gKeys[0]) : NOV_2026_ACTIVE_MODELS;
            return res.status(200).json({
                ok: true,
                releaseBaseUrl: getNormalizedReleaseBaseUrl(),
                autoDiscoveredModels: discovered.slice(0, 5),
                e2eAudioSupported: true
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

            const brainBadge = typeof chatResult.geminiKeyUsed === "number"
                ? `G-Key #${chatResult.geminiKeyUsed}`
                : chatResult.geminiKeyUsed;

            return res.status(200).json({
                aiText: chatResult.aiText,
                heardText: chatResult.heardText || body.userText || "",
                emotion: chatResult.emotion || "talking",
                geminiKeyUsed: chatResult.geminiKeyUsed,
                modelUsed: chatResult.modelUsed,
                agiAction: chatResult.agiAction || null,
                newMemoryFact: chatResult.newMemoryFact || null,
                audioBase64: ttsResult.audioBase64,
                engineLabel: `${brainBadge} (${chatResult.modelUsed}) | ${ttsResult.engineLabel}`,
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
            return res.status(200).json(await generateGeminiReplyInternal(body));
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    if (action === "tts") {
        const text = (body.text || "").trim();
        if (!text) return res.status(400).json({ error: "Empty text for TTS" });
        try {
            const ttsResult = await generateTtsAudioInternal(text);
            return res.status(200).json({ ...ttsResult, emotion: body.forceEmotion || detectPapaVideoState("", text) });
        } catch (err) {
            return res.status(502).json({ error: err.message });
        }
    }

    if (action === "diag") {
        const geminiKeys = getGeminiKeysFromEnv();
        const groqKeys = getGroqKeysFromEnv();
        const { pool: cartesiaPool, allVoices } = getCartesiaPoolFromEnv();
        const logs = [];
        let firstSuccessAudio = null;
        let activeKeyLabel = null;

        const liveModels = geminiKeys.length > 0 ? await getAutoUpdatedGeminiModelsList(geminiKeys[0]) : NOV_2026_ACTIVE_MODELS;
        logs.push(`🔄 AUTO-DISCOVERED LIVE GEMINI MODELS: ${liveModels.slice(0, 5).join(", ")}`);
        logs.push(`🚀 UNIVERSAL END-TO-END PAPA AGI: Native Audio + Vision + Docs + Auto-Memory + Web Search`);
        logs.push(`🧠 GEMINI KEYS FOUND: ${geminiKeys.length} | ⚡ GROQ BACKUP KEYS FOUND: ${groqKeys.length}`);

        for (let g = 0; g < geminiKeys.length; g++) {
            const gKey = geminiKeys[g];
            const masked = gKey.slice(0, 6) + "..." + gKey.slice(-4);
            let keyWorked = false;
            let lastGStatus = "";
            for (const testModel of liveModels.slice(0, 3)) {
                try {
                    const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${gKey}`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "नमस्ते" }] }], generationConfig: { maxOutputTokens: 20 } })
                    });
                    if (gRes.ok) {
                        logs.push(`✅ Gemini Key #${g + 1} (${masked}): ACTIVE on ${testModel}!`);
                        geminiKeyIdx = g;
                        keyWorked = true;
                        break;
                    }
                    lastGStatus = `HTTP ${gRes.status} on ${testModel}`;
                } catch (e) {
                    lastGStatus = e.message;
                }
            }
            if (!keyWorked) logs.push(`⚠️ Gemini Key #${g + 1} (${masked}): Quota Full (${lastGStatus}) -> Backup AI Ready`);
        }

        logs.push(`\n🎙️ CARTESIA VOICES FOUND: ${allVoices.length} | KEYS FOUND: ${cartesiaPool.length}`);
        for (let k = 0; k < cartesiaPool.length; k++) {
            const entry = cartesiaPool[k];
            const maskedKey = entry.key.slice(0, 9) + "..." + entry.key.slice(-4);
            const resTest = await tryKeyAcrossAllVoices(entry, "नमस्ते बेटा, सदा खुश रहो, मेरा आशीर्वाद हमेशा तुम्हारे साथ है।");
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
        return res.status(200).json({ logs, foundWorking: Boolean(firstSuccessAudio), activeKeyLabel, audioBase64: firstSuccessAudio });
    }

    return res.status(400).json({ error: "Invalid action" });
}
