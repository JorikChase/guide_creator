const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// --- ROBUST .ENV LOADING ---
// Look for .env in: 1. Current Dir, 2. Executable Dir, 3. App Source Dir
const possibleEnvPaths = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(process.execPath), '.env'),
    path.join(__dirname, '.env')
];

for (const envPath of possibleEnvPaths) {
    if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
        console.log(`Loaded .env from: ${envPath}`);
        break;
    }
}

// --- EMBEDDED DEFAULT CREDENTIALS ---
// These are used if the .env file is missing
const DEFAULTS = {
};

// Helper to get env or default
const getEnv = (key) => process.env[key] || DEFAULTS[key];

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron'); // Added shell
const { spawn } = require('child_process');
const https = require('https');
const ftp = require('basic-ftp');
const crypto = require('crypto'); // Added crypto for PKCE

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
    app.quit();
}

const args = process.argv.slice(1);

// --- GPU & SANDBOX CONFIGURATION ---
// Automatic fix for "GPU process launch failed: error_code=18" which occurs when running from network shares (S:\)
const isNetworkDrive = process.platform === 'win32' && !__dirname.startsWith('C:');

if (args.includes('--disable-gpu') || args.includes('--no-hw') || isNetworkDrive) {
    app.disableHardwareAcceleration();
    console.log(isNetworkDrive ? "[AUTO] Hardware acceleration disabled (Network Drive Detected)." : "Hardware acceleration disabled via CLI flag.");
}

if (args.includes('--no-sandbox') || isNetworkDrive) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    console.log(isNetworkDrive ? "[AUTO] Chromium sandbox disabled (Network Drive Detected)." : "Chromium sandbox disabled via CLI flag.");
}


const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxJm8DPQ9hw5CRg9pgsbQMEyPzl9eTVu8LFaPPUzPfx5EF5zDfL4o8apxzUXS02wShTxQ/exec';

// --- ADOBE OAUTH CONFIGURATION ---
const ADOBE_SCHEME = 'adobe+a1385a5a99e3cc61b65afdc24dd68201301fa743';
const ADOBE_CLIENT_ID = '077729429eda4ac5905d31e05815217b';
const ADOBE_REDIRECT_URI = `${ADOBE_SCHEME}://adobeid/${ADOBE_CLIENT_ID}`;

let v4AccessToken = null;
let authResolve = null;
let authReject = null;
let currentCodeVerifier = null;

// --- DEEP LINKING & SINGLE INSTANCE LOCK ---
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(ADOBE_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient(ADOBE_SCHEME);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        const url = commandLine.find(arg => arg.startsWith(`${ADOBE_SCHEME}://`));
        if (url) handleAdobeRedirect(url);
    });
}

app.on('open-url', (event, url) => {
    event.preventDefault();
    handleAdobeRedirect(url);
});

let mainWindow;

let globalShotDataMap = {};
let globalFrameIoLinks = {};

// --- State Management ---
let currentFfmpegProcess = null;
let debugMode = false;
let processingState = {
    isProcessing: false,
    isPaused: false,
    shouldStop: false,
};

// --- Helper for binary paths ---
const isDev = !app.isPackaged;
const getBinaryPath = (binaryName) => {
    if (isDev) {
        return path.join(__dirname, 'bin', binaryName);
    }
    return path.join(process.resourcesPath, 'bin', binaryName);
};

function createWindow() {
    const iconPath = path.join(__dirname, 'logo', process.platform === 'win32' ? 'logo.ico' : 'logo.icns');
    mainWindow = new BrowserWindow({
        width: 800,
        height: 700,
        icon: iconPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: false
        },
        frame: false,
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.on('app:quit', () => app.quit());

ipcMain.on('toggle-debug', (event, enabled) => {
    debugMode = enabled;
    if (debugMode && mainWindow) {
        mainWindow.webContents.openDevTools();
    } else if (mainWindow) {
        mainWindow.webContents.closeDevTools();
    }
});

ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Movies', extensions: ['mov', 'qt'] }]
    });
    return canceled ? undefined : filePaths;
});

// Custom CSV line parser to handle commas within quoted fields
function parseCsvLine(line) {
    const columns = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++; // Skip the next quote
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            columns.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    columns.push(current);
    return columns;
}

// Correctly splits a CSV string into an array of lines, handling newlines within quoted fields.
function splitCsvToLines(csvString) {
    const rows = [];
    let inQuotes = false;
    let currentRowStart = 0;
    const text = csvString.trim().replace(/\r\n/g, '\n');
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === '"') {
            if (inQuotes && text[i + 1] === '"') {
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        }
        if (char === '\n' && !inQuotes) {
            rows.push(text.substring(currentRowStart, i));
            currentRowStart = i + 1;
        }
    }
    if (currentRowStart < text.length) {
        rows.push(text.substring(currentRowStart));
    }
    return rows;
}

ipcMain.handle('fetch-sheet-data', () => {
    return new Promise((resolve, reject) => {
        const sheetUrl = 'https://docs.google.com/spreadsheets/d/1f_livXNivwuvQrU4gGDenyLhBlI9V4RaR_MS_5iv7mg/gviz/tq?tqx=out:csv&sheet=guide_import';
        log(`Fetching Google Sheet data from: ${sheetUrl}`);

        https.get(sheetUrl, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Google Sheet request failed: ${res.statusCode}`));
            }

            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    const lines = splitCsvToLines(rawData);
                    if (lines[0] && lines[0].charCodeAt(0) === 0xFEFF) lines[0] = lines[0].substring(1);
                    if (lines.length < 1) return reject(new Error('CSV data is empty.'));

                    const headerLine = lines.shift() || '';
                    const headerNames = parseCsvLine(headerLine).map(h => h.replace(/^"|"$/g, '').trim());

                    const idIndex = headerNames.findIndex(h => h.toUpperCase() === 'ID');
                    const guideNameIndex = headerNames.findIndex(h => h.toUpperCase() === 'GUIDE_NAME');
                    const pathIndex = headerNames.findIndex(h => h.toUpperCase() === 'PATH');

                   const shotIdIndex = headerNames.findIndex(h => h.toUpperCase() === 'SHOT_ID');

                    if (idIndex === -1 || guideNameIndex === -1 || pathIndex === -1) {
                        return reject(new Error('Missing required columns ID, GUIDE_NAME, or PATH'));
                    }

                    const shotDataMap = {};
                    lines.forEach((line, rowIndex) => {
                        const columns = parseCsvLine(line).map(c => c.replace(/^"|"$/g, '').trim());
                        if (columns.length <= Math.max(idIndex, guideNameIndex, pathIndex) && line.trim() !== '') return;

                        const id = columns[idIndex];
                        if (id) {
                                    let folderName = 'UNMATCHED_SCENE';
                                    if (shotIdIndex !== -1 && columns[shotIdIndex]) {
                                        // Takes "sc01-startcredits-sh010", splits at "-sh", takes the first part, and uppercases it.
                                        folderName = columns[shotIdIndex].split('-sh')[0].toUpperCase();
                                    }

                                    shotDataMap[id] = {
                                        guideName: columns[guideNameIndex] || 'UNKNOWN_GUIDE_NAME',
                                        path: columns[pathIndex] || 'UNKNOWN_PATH',
                                        sceneName: folderName,
                                        shotId: columns[shotIdIndex] || 'UNKNOWN_SHOT_ID'
                                    };
                                }
                    });

                    globalShotDataMap = shotDataMap; // MODIFICATION: Cache for later intercept
                    resolve(shotDataMap);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (e) => reject(e));
    });
});

ipcMain.on('update-sheet-data', (event, { chapterId, sheetRowId, dur_f, dur_s, guide_version }) => {
    if (!sheetRowId) return;

    const frame_io_link = globalFrameIoLinks[chapterId] || '';
    const postData = JSON.stringify({
        id: sheetRowId,
        dur_f: dur_f,
        dur_s: dur_s,
        guide_v: guide_version,
        frame_io_link: frame_io_link 
    });

    const urls = [GOOGLE_APPS_SCRIPT_URL];

    urls.forEach(url => {
        const makeRequest = (targetUrl, method = 'POST', redirectCount = 0) => {
            if (redirectCount > 5) return;
            const urlObject = new URL(targetUrl);
            const options = { method: method, headers: { 'Content-Type': 'application/json' } };
            if (method === 'POST') options.headers['Content-Length'] = Buffer.byteLength(postData);

            const req = https.request(urlObject, options, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    makeRequest(res.headers.location, 'GET', redirectCount + 1);
                    res.resume();
                    return;
                }
                let responseBody = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { responseBody += chunk; });
                res.on('end', () => {
                    let parsedResponse;
                    try { parsedResponse = JSON.parse(responseBody); } catch (e) { parsedResponse = { status: 'error' }; }
                    if (mainWindow) mainWindow.webContents.send('sheet-update-response', { sheetRowId, success: parsedResponse.status === 'success', url: targetUrl });
                });
            });
            if (method === 'POST') req.write(postData);
            req.on('error', (e) => {
                log(`[ERROR] Failed to post to ${targetUrl}: ${e.message}`);
            });
            req.end();
        };
        makeRequest(url);
    });
});

ipcMain.on('analyze-videos', async (event, filePaths) => {
    log('--- Starting video analysis ---');
    const ffprobePath = getBinaryPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

    if (!fs.existsSync(ffprobePath)) {
        const errorMsg = 'ffprobe.exe executable not found for analysis!';
        log(`[ERROR] Searched for ffprobe at: ${ffprobePath}`);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }

    let allChapters = [];
    for (const filePath of filePaths) {
        try {
            mainWindow.webContents.send('update-status', `Analyzing: ${path.basename(filePath)}`);
            const chapters = await getChapters(ffprobePath, filePath);
            const chaptersWithContext = chapters.map((c, i) => ({
                id: `ch-${path.basename(filePath)}-${i}`,
                title: c.tags.title,
                start_time: c.start_time,
                end_time: c.end_time, // Added end_time for robust processing
                sourceFile: filePath,
                fileName: path.basename(filePath)
            }));
            allChapters.push(...chaptersWithContext);
            log(`Found ${chapters.length} chapters in ${path.basename(filePath)}.`);
        } catch (error) {
            log(`Error analyzing ${filePath}: ${error}`);
            mainWindow.webContents.send('processing-error', `Error analyzing ${filePath}: ${error.message}`);
            mainWindow.webContents.send('analyze-complete', []);
            return;
        }
    }

    log(`--- Analysis complete. Found ${allChapters.length} total chapters. ---`);
    mainWindow.webContents.send('analyze-complete', allChapters);
});

function killFfmpeg(reason = 'unknown') {
    if (!currentFfmpegProcess || currentFfmpegProcess.killed) {
        log(`killFfmpeg called for reason "${reason}", but no process was found or it was already killed.`);
        return;
    }
    const pid = currentFfmpegProcess.pid;
    log(`Attempting to kill FFmpeg process with PID: ${pid} for reason: ${reason}`);

    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', pid, '/f', '/t']);
    } else {
        // Kill the entire process group by negating the PID
        try {
            process.kill(-pid, 'SIGKILL');
        } catch (e) {
            log(`Could not kill process group ${-pid}, falling back to single process ${pid}. Error: ${e.message}`);
            currentFfmpegProcess.kill('SIGKILL');
        }
    }

    currentFfmpegProcess = null;
}

ipcMain.on('control-processing', (event, action) => {
    log(`[CONTROL] Received: ${action}`);
    if (action === 'pause') {
        processingState.isPaused = true;
        log('--- Processing Paused ---');
        mainWindow.webContents.send('update-status', 'Paused...');
        killFfmpeg('pause');
    } else if (action === 'resume') {
        processingState.isPaused = false;
        log('--- Processing Resumed ---');
        mainWindow.webContents.send('update-status', 'Processing...');
    } else if (action === 'stop') {
        processingState.shouldStop = true;
        processingState.isPaused = false;
        log('--- User requested stop. Killing current FFmpeg process... ---');
        killFfmpeg('stop');
    }
});

ipcMain.on('process-videos', async (event, { chapters, overwrite }) => {
    // MODIFICATION: Secure the V4 Token before processing starts
    mainWindow.webContents.send('update-status', 'Waiting for Adobe Login...');
    try {
        await authenticateAdobe();
    } catch (e) {
        log(`[FATAL] Adobe Login Failed: ${e.message}`);
        mainWindow.webContents.send('processing-error', 'Adobe Login Failed. Check console.');
        return;
    }

    const baseDir = debugMode ? 'S:\\3212-PREPRODUCTION_TEST' : 'S:\\3212-PREPRODUCTION';

    const ffmpegPath = getBinaryPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ffprobePath = getBinaryPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

    processingState.isProcessing = true;
    processingState.isPaused = false;
    processingState.shouldStop = false;

    const videoInfos = {};
    for (const chapter of chapters) {
        if (!videoInfos[chapter.sourceFile]) {
            videoInfos[chapter.sourceFile] = await getVideoInfo(ffprobePath, chapter.sourceFile);
        }
    }

    for (let i = 0; i < chapters.length; i++) {
        if (processingState.shouldStop) break;
        while (processingState.isPaused) {
            if (processingState.shouldStop) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (processingState.shouldStop) break;

        const chapter = chapters[i];
        let finalClipName;

        let chapterOutputDir;
        if (chapter.path && chapter.path !== 'UNKNOWN_PATH' && chapter.path.trim() !== '') {
            chapterOutputDir = path.join(baseDir, chapter.path.replace(/[:*?"<>|]/g, '')).toUpperCase();
        } else {
            chapterOutputDir = path.join(baseDir, '_UNMATCHED', path.basename(chapter.sourceFile, path.extname(chapter.sourceFile))).toUpperCase();
        }

        try { fs.mkdirSync(chapterOutputDir, { recursive: true }); } catch (error) { continue; }

        const baseClipName = chapter.title.replace(/[ /\\?%*:|"<>]/g, '_');
        let version = 1;

        if (overwrite) {
            let highestFound = 0;
            if (fs.existsSync(chapterOutputDir)) {
                const files = fs.readdirSync(chapterOutputDir);
                const versionPattern = new RegExp(`^${baseClipName}-v(\\d+)\\.mp4$`, 'i');
                files.forEach(file => {
                    const match = file.match(versionPattern);
                    if (match) {
                        const vNum = parseInt(match[1]);
                        if (vNum > highestFound) highestFound = vNum;
                    }
                });
            }
            version = highestFound > 0 ? highestFound : 1;
        } else {
            while (true) {
                const versionString = `v${String(version).padStart(3, '0')}`;
                const checkName = `${baseClipName}-${versionString}`.toLowerCase();
                if (!fs.existsSync(path.join(chapterOutputDir, `${checkName}.mp4`))) break;
                version++;
            }
        }

        const versionString = `v${String(version).padStart(3, '0')}`;
        finalClipName = `${baseClipName}-${versionString}`.toLowerCase();

        mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Processing', finalName: finalClipName });

        try {
            const videoInfo = videoInfos[chapter.sourceFile];
            const videoDuration = parseFloat(videoInfo.format.duration);
            const startTime = parseFloat(chapter.start_time);
            let endTime = chapter.end_time ? parseFloat(chapter.end_time) : videoDuration;

           // MODIFICATION: Find the true Sheet ID by matching the Guide Name!
        let sheetRowId = chapter.id; // Fallback
        let sceneName = 'UNMATCHED';
        let shotId = 'UNKNOWN_SHOT_ID';

        // Scan the downloaded sheet data to find which row this chapter belongs to
        for (const [idKey, data] of Object.entries(globalShotDataMap)) {
            if (data.guideName && data.guideName.trim() === chapter.title.trim()) {
                sheetRowId = idKey; // We found the exact Google Sheet ID!
                if (data.sceneName) sceneName = data.sceneName.replace(/[ /\\?%*:|"<>]/g, '_');
                if (data.shotId) shotId = data.shotId.replace(/[ /\\?%*:|"<>]/g, '_');
                break;
            }
        }

        // Pass the confirmed sheetRowId down into the processing function
        const finalChapter = { ...chapter, title: finalClipName, startTime, endTime, sceneName, sheetRowId, shotId };
        const result = await processSingleChapter(ffmpegPath, ffprobePath, videoInfo, finalChapter, chapterOutputDir);

            mainWindow.webContents.send('chapter-update', {
                chapterId: chapter.id, status: 'Done',
                durationSeconds: result.durationSeconds, durationFrames: result.durationFrames, 
                guide_version: version, sheetRowId: finalChapter.sheetRowId
            });
        } catch (error) {
            if (error.message === 'paused') { i--; continue; }
            if (processingState.shouldStop || error.message === 'stopped') break;
            mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Error' });
        }
    }

    processingState.isProcessing = false;
    currentFfmpegProcess = null;
    mainWindow.webContents.send(processingState.shouldStop ? 'processing-stopped' : 'processing-complete');
});

// --- Helper Functions ---

let lastIpcLogTime = 0;
const IPC_LOG_THROTTLE_MS = 50; // Max 20 updates per second to the renderer

function log(message, forceIpc = false) {
    if (debugMode) console.log(message);
    
    const now = Date.now();
    // Only send to renderer if forced (important status) or if debug is on, or if throttled
    if (mainWindow && (forceIpc || debugMode || (now - lastIpcLogTime > IPC_LOG_THROTTLE_MS))) {
        mainWindow.webContents.send('log-message', message);
        lastIpcLogTime = now;
    }

    const logPath = path.join(app.getPath('userData'), 'app.log');
    // Use async appendFile to prevent blocking the main thread
    fs.appendFile(logPath, `${new Date().toISOString()} - ${message}\n`, (error) => {
        if (error) console.error("Failed to write to log file:", error);
    });
}

function getChapters(ffprobePath, filePath) {
    return new Promise((resolve, reject) => {
        const args = ['-i', filePath, '-print_format', 'json', '-show_chapters', '-loglevel', 'error'];
        log(`Running ffprobe: ${ffprobePath} ${args.join(' ')}`);
        const ffprobe = spawn(ffprobePath, args);
        let output = '';
        ffprobe.stdout.on('data', (data) => output += data);
        ffprobe.stderr.on('data', (data) => log(`ffprobe stderr: ${data}`));
        ffprobe.on('close', (code) => {
            if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
            try {
                const data = JSON.parse(output);
                resolve(data.chapters || []);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output.'));
            }
        });
    });
}

async function processSingleChapter(ffmpegPath, ffprobePath, videoInfo, chapter, chapterOutputDir) {
    const { sourceFile, title, startTime, endTime, sceneName, shotId } = chapter;
    const clipName = title;

    const videoStream = videoInfo.streams.find(s => s.codec_type === 'video');
    const outputFilePath = path.join(chapterOutputDir, `${clipName}.mp4`);

    try {
        let frameRate = 30;
        try { frameRate = eval(videoStream.r_frame_rate); } catch (e) { }
        if (!frameRate || frameRate <= 0) frameRate = 30;

        const frameDuration = 1 / frameRate;
        const tenFramesDuration = 10 * frameDuration;
        const audioStream = videoInfo.streams.find(s => s.codec_type === 'audio');
        const hasAudio = !!audioStream;

        const prefixStillPath = path.join(chapterOutputDir, `prefix_${clipName}.png`);
        const suffixStillPath = path.join(chapterOutputDir, `suffix_${clipName}.png`);
        const metadataFilePath = path.join(chapterOutputDir, `metadata_${clipName}.txt`);

        await createStillFrame(ffmpegPath, sourceFile, startTime, prefixStillPath);

        const suffixTime = Math.max(startTime, endTime - frameDuration);
        try {
            await createStillFrame(ffmpegPath, sourceFile, suffixTime, suffixStillPath);
        } catch (e) {
            const safeSuffixTime = Math.max(startTime, suffixTime - (frameDuration * 3));
            await createStillFrame(ffmpegPath, sourceFile, safeSuffixTime, suffixStillPath);
        }

        const chapterDuration = endTime - startTime;
        const newChapterStartTime = tenFramesDuration;
        const newChapterEndTime = newChapterStartTime + chapterDuration;
        const timebase = 1000000;
        const metadataContent = `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/${timebase}\nSTART=${Math.round(newChapterStartTime * timebase)}\nEND=${Math.round(newChapterEndTime * timebase)}\ntitle=${title}\n`;
        fs.writeFileSync(metadataFilePath, metadataContent);

        const complexFilterParts = [];
        const videoTrimEndTime = Math.max(startTime, endTime - frameDuration);

        complexFilterParts.push(`[1:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[pre_v]`);
        complexFilterParts.push(`[0:v]trim=start=${startTime}:end=${videoTrimEndTime},setpts=PTS-STARTPTS,scale=960:540:flags=lanczos+accurate_rnd[main_v]`);
        complexFilterParts.push(`[2:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[suf_v]`);

        if (hasAudio) {
            const sampleRate = audioStream.sample_rate || '48000';
            const channelLayout = audioStream.channel_layout || 'stereo';
            const audioParts = [];
            const isFirstChapterInFile = startTime < tenFramesDuration;
            if (isFirstChapterInFile) {
                complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[pre_a]`);
            } else {
                complexFilterParts.push(`[0:a]atrim=start=${Math.max(0, startTime - tenFramesDuration)}:end=${startTime},asetpts=PTS-STARTPTS[pre_a]`);
            }
            audioParts.push('[pre_a]');
            complexFilterParts.push(`[0:a]atrim=start=${startTime}:end=${endTime},asetpts=PTS-STARTPTS[main_a]`);
            audioParts.push('[main_a]');
            if (endTime > (parseFloat(videoInfo.format.duration) - frameDuration)) {
                complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[suf_a]`);
            } else {
                complexFilterParts.push(`[0:a]atrim=start=${endTime}:end=${Math.min(parseFloat(videoInfo.format.duration), endTime + tenFramesDuration)},asetpts=PTS-STARTPTS[suf_a]`);
            }
            audioParts.push('[suf_a]');
            complexFilterParts.push(`${audioParts.join('')}concat=n=${audioParts.length}:v=0:a=1[out_a]`);
        }

        complexFilterParts.push(`[pre_v][main_v][suf_v]concat=n=3:v=1,fps=${videoStream.r_frame_rate}[out_v]`);
        const filterComplexString = complexFilterParts.join(';');

        const ffmpegArgs = [
            '-i', sourceFile, '-framerate', videoStream.r_frame_rate, '-i', prefixStillPath,
            '-framerate', videoStream.r_frame_rate, '-i', suffixStillPath, '-i', metadataFilePath,
            '-filter_complex', filterComplexString, '-map', '[out_v]'
        ];
        if (hasAudio) ffmpegArgs.push('-map', '[out_a]');

        ffmpegArgs.push(
            '-brand', 'mp42', '-map_chapters', '3',
            '-c:v', 'libx264', '-profile:v', 'main', '-level', '3.1', '-pix_fmt', 'yuv420p',
            '-g', '1', '-b:v', '3000k', '-maxrate', '4500k', '-bufsize', '6000k',
            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
            '-metadata:s:v:0', 'handler_name=AVC Coding', '-metadata:s:v:0', 'language=eng'
        );

        if (hasAudio) ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-metadata:s:a:0', 'language=eng');
        ffmpegArgs.push('-y', outputFilePath);

        await runFfmpeg(ffmpegPath, ffmpegArgs);

        // MODIFICATION BEGIN: Execute Thumbnail & Frame.io Tasks Securely

        // 1. Thumbnail + FTP 
        const middleTime = Math.max(startTime, startTime + (chapterDuration / 2));
        const thumbNameBase = (shotId && shotId !== 'UNKNOWN_SHOT_ID') ? shotId : clipName;
        log(`[THUMBNAIL] Mapping check: shotId=${shotId}, clipName=${clipName} -> Final Name: ${thumbNameBase}.jpg`, true);
        const thumbnailPath = path.join(chapterOutputDir, `${thumbNameBase}.jpg`);
        mainWindow.webContents.send('update-status', 'Generating thumbnail...');
        await createThumbnail(ffmpegPath, sourceFile, middleTime, thumbnailPath);

        mainWindow.webContents.send('update-status', 'Uploading thumbnail to FTP...');
        try { 
            if (!fs.existsSync(thumbnailPath)) {
                log(`[ERROR] Thumbnail file not created: ${thumbnailPath}`, true);
            } else {
                await uploadThumbnailToFTP(thumbnailPath); 
                log(`[SUCCESS] Thumbnail uploaded for ${thumbNameBase}`, true);
            }
        }
        catch (e) { log(`[WARNING] FTP Error: ${e.message}`, true); }

        // 2. Frame.io
        let frameIoLink = "";
        mainWindow.webContents.send('update-status', 'Uploading to Frame.io...');
        try { frameIoLink = await uploadToFrameio(outputFilePath, clipName, sceneName); }
        catch (e) { log(`[WARNING] Frame.io Error: ${e.message}`, true); }

        // 3. Cache Link for Google Sheets update (keyed by unique chapter.id)
        globalFrameIoLinks[chapter.id] = frameIoLink;

        const newClipInfo = await getVideoInfo(ffprobePath, outputFilePath);
        const durationSecondsFloat = parseFloat(newClipInfo.format.duration);
        const newFrameRate = eval(newClipInfo.streams.find(s => s.codec_type === 'video').r_frame_rate);
        return {
            durationFrames: Math.round(durationSecondsFloat * newFrameRate),
            durationSeconds: Math.round(durationSecondsFloat)
        };

    } finally {
        for (const file of [path.join(chapterOutputDir, `prefix_${clipName}.png`), path.join(chapterOutputDir, `suffix_${clipName}.png`), path.join(chapterOutputDir, `metadata_${clipName}.txt`)]) {
            try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { }
        }
    }
}

function createStillFrame(ffmpegPath, filePath, time, outputPath) {
    const seekTime = Math.max(0, time);
    // Scale the still frame to 960:540 to match the main video output.
    // The drawbox filter is applied after scaling.
    // Added -update 1 to satisfy "image sequence pattern" requirement for single images
    // MODIFICATION: Updated scaler to lanczos+accurate_rnd for consistency and quality
    const args = [
        '-ss', seekTime.toString(), '-i', filePath,
        // x=101 (101px from left), y=ih-43 (20px from bottom: ih - 20 - 23 = ih - 43), w=13, h=23
        '-vf', 'scale=960:540:flags=lanczos+accurate_rnd,drawbox=x=88:y=ih-43:w=13:h=23:color=red:t=fill',
        '-vframes', '1', '-update', '1', '-y', outputPath
    ];
    return runFfmpeg(ffmpegPath, args);
}

function getVideoInfo(ffprobePath, filePath) {
    return new Promise((resolve, reject) => {
        const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
        const ffprobe = spawn(ffprobePath, args);
        let output = '';
        ffprobe.stdout.on('data', (data) => output += data);
        ffprobe.stderr.on('data', (data) => log(`ffprobe stderr: ${data}`));
        ffprobe.on('close', (code) => {
            if (code !== 0) return reject(new Error(`ffprobe exited with code ${code}`));
            try {
                resolve(JSON.parse(output));
            } catch (e) {
                reject(new Error('Failed to parse video info.'));
            }
        });
    });
}

// --- AUTHENTICATION LOGIC ---
async function handleAdobeRedirect(url) {
    if (!authResolve) return;
    
    try {
        mainWindow.webContents.send('update-status', 'Authenticating with Adobe...');
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        const error = urlObj.searchParams.get('error');

        if (error) throw new Error(error);
        if (!code) throw new Error("No authorization code returned.");

        const tokenRes = await fetch('https://ims-na1.adobelogin.com/ims/token/v3', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: ADOBE_CLIENT_ID,
                code: code,
                redirect_uri: ADOBE_REDIRECT_URI,
                code_verifier: currentCodeVerifier
            })
        });

        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
            v4AccessToken = tokenData.access_token;
            console.log("✅ Successfully authenticated with Adobe IMS (V4 Token acquired)!");
            authResolve(v4AccessToken);
        } else {
            throw new Error('Failed to obtain access token from Adobe.');
        }
    } catch (e) {
        console.error("Adobe Auth Error:", e);
        if (authReject) authReject(e);
    } finally {
        authResolve = null;
        authReject = null;
        currentCodeVerifier = null;
    }
}

async function authenticateAdobe() {
    if (v4AccessToken) return v4AccessToken;

    return new Promise((resolve, reject) => {
        authResolve = resolve;
        authReject = reject;

        currentCodeVerifier = crypto.randomBytes(32).toString('base64url');
        const codeChallenge = crypto.createHash('sha256').update(currentCodeVerifier).digest('base64url');

        // FIX: Only standard Adobe IMS scopes are valid here.
        // Frame.io-specific scopes (asset.read, project.read etc.) do NOT exist
        // in IMS and will cause invalid_scope. Authorization of what the user
        // can do in Frame.io is controlled by their roles inside Frame.io itself.
        const scopes = [
            'openid',
            'offline_access',
            'email',
            'profile',
            'additional_info.roles'
        ].join(' ');

        const authUrl = [
            'https://ims-na1.adobelogin.com/ims/authorize/v2',
            `?client_id=${ADOBE_CLIENT_ID}`,
            `&redirect_uri=${encodeURIComponent(ADOBE_REDIRECT_URI)}`,
            `&scope=${encodeURIComponent(scopes)}`,
            `&response_type=code`,
            `&code_challenge=${codeChallenge}`,
            `&code_challenge_method=S256`
        ].join('');

        log(`[Adobe Auth] Opening browser for login...`);
        shell.openExternal(authUrl);
    });
}

// MODIFICATION: Frame.io V4 fetch wrapper
async function frameioReq(method, endpoint, body) {
    const url = `https://api.frame.io/v4${endpoint}`;
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${v4AccessToken}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return await res.json();
}

async function uploadToFrameio(filePath, clipName, sceneName) {
    const TARGET_PROJECT_NAME = "321 TO THE MOON";

    // STEP 0: Ensure we have a token
    if (!v4AccessToken) {
        v4AccessToken = getEnv('FRAMEIO_TOKEN');
        if (!v4AccessToken) {
            log("[Frame.io] No token found, triggering OAuth login...");
            await handleFrameioAuth();
            // handleFrameioAuth doesn't return the token, it waits for the redirect
            // Since this is a standalone tool, we might need a better flow, 
            // but for now, we rely on the user logging in or the embedded token.
        } else {
            log("[Frame.io] Using embedded/env access token.");
        }
    }

    // STEP 1: Get account_id from /accounts 
    const accountsRes = await frameioReq('GET', '/accounts');
    
    // V4 responses typically wrap lists in a 'data' array
    const accounts = accountsRes.data || []; 
    
    if (!accounts.length) {
        throw new Error('No accounts found for this user. Ensure the user is linked to a Frame.io V4 account.');
    }

    // Default to the first account the user has access to.
    // If your users have multiple accounts, you might need to filter by account name later.
    const accountId = accounts[0].id; 
    log(`[Frame.io] Using account_id: ${accountId}`);

    // STEP 2: List workspaces under this account
    const workspacesRes = await frameioReq('GET', `/accounts/${accountId}/workspaces`);
    const workspaces = workspacesRes.data || [];
    if (!workspaces.length) throw new Error('No workspaces found for this account.');

    // STEP 3: Search all workspaces for our target project
    let rootFolderId = null;
    let projectId = null;

    for (const workspace of workspaces) {
        const projectsRes = await frameioReq('GET', `/accounts/${accountId}/workspaces/${workspace.id}/projects`);
        const projects = projectsRes.data || [];

        const project = projects.find(p => p.name.toUpperCase() === TARGET_PROJECT_NAME.toUpperCase());
        if (project) {
            // FIX: V4 uses root_folder_id, not root_asset_id
            rootFolderId = project.root_folder_id;
            projectId = project.id;
            log(`[Frame.io] Found project "${project.name}" (id: ${projectId}), root_folder_id: ${rootFolderId}`);
            break;
        }
    }

    if (!rootFolderId) {
        throw new Error(`Could not find project "${TARGET_PROJECT_NAME}" in any workspace.`);
    }

    // STEP 4: Find or create GUIDES folder inside root
    // FIX: V4 uses /folders/{id}/children, not /assets/{id}/children
    const rootChildrenRes = await frameioReq('GET', `/accounts/${accountId}/folders/${rootFolderId}/children`);
    let rootChildren = rootChildrenRes.data || [];

    let guidesFolder = rootChildren.find(item => item.name.toUpperCase() === 'GUIDES' && item.type === 'folder');
    if (!guidesFolder) {
        log(`[Frame.io] Creating GUIDES folder...`);
        // Post directly to the root folder's /folders endpoint
        const newFolder = await frameioReq('POST', `/accounts/${accountId}/folders/${rootFolderId}/folders`, {
            data: { name: 'GUIDES' }
        });
        guidesFolder = newFolder.data;
        log(`[Frame.io] Created GUIDES folder (id: ${guidesFolder.id})`);
    } else {
        log(`[Frame.io] Found existing GUIDES folder (id: ${guidesFolder.id})`);
    }

    // STEP 5: Find or create SCENE folder inside GUIDES
    const guidesChildrenRes = await frameioReq('GET', `/accounts/${accountId}/folders/${guidesFolder.id}/children`);
    let guidesChildren = guidesChildrenRes.data || [];

    let sceneFolder = guidesChildren.find(item => item.name.toUpperCase() === sceneName.toUpperCase() && item.type === 'folder');
    if (!sceneFolder) {
        log(`[Frame.io] Creating scene folder "${sceneName}"...`);
        // Post directly to the GUIDES folder's /folders endpoint
        const newFolder = await frameioReq('POST', `/accounts/${accountId}/folders/${guidesFolder.id}/folders`, {
            data: { name: sceneName }
        });
        sceneFolder = newFolder.data;
        log(`[Frame.io] Created scene folder (id: ${sceneFolder.id})`);
    } else {
        log(`[Frame.io] Found existing scene folder "${sceneName}" (id: ${sceneFolder.id})`);
    }

    // STEP 6: Create the file placeholder in Frame.io
    // FIX: V4 file creation uses POST /accounts/{account_id}/folders/{folder_id}/files
    const stat = fs.statSync(filePath);
    log(`[Frame.io] Creating file placeholder for "${path.basename(filePath)}" (${stat.size} bytes)...`);

    const fileRes = await frameioReq('POST', `/accounts/${accountId}/folders/${sceneFolder.id}/files`, {
        data: {
            name: path.basename(filePath),
            file_size: stat.size,
            media_type: 'video/mp4'
        }
    });
    const fileAsset = fileRes.data;
    log(`[Frame.io] File placeholder created (id: ${fileAsset.id}), got ${fileAsset.upload_urls?.length || 0} upload URL(s).`);

    // STEP 7: Upload file chunks to S3 pre-signed URLs
    // FIX: V4 upload_urls is an array of objects { url, size } — not a flat array of strings
    // FIX: S3 PUT requires x-amz-acl: private header
    const uploadUrls = fileAsset.upload_urls;
    if (!uploadUrls || uploadUrls.length === 0) {
        throw new Error('No upload_urls returned from Frame.io file creation.');
    }

    const fd = fs.openSync(filePath, 'r');
    try {
        let offset = 0;
        for (let i = 0; i < uploadUrls.length; i++) {
            const part = uploadUrls[i]; // { url: "...", size: 12345 }
            const chunkSize = part.size;
            const buffer = Buffer.alloc(chunkSize);
            const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, offset);
            offset += bytesRead;

            log(`[Frame.io] Uploading part ${i + 1}/${uploadUrls.length} (${bytesRead} bytes)...`);
            const s3Res = await fetch(part.url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'video/mp4',
                    'x-amz-acl': 'private'   // FIX: required by V4
                },
                body: buffer.subarray(0, bytesRead)
            });

            if (!s3Res.ok) {
                // S3 errors come back as XML, not JSON
                const errText = await s3Res.text();
                throw new Error(`S3 upload failed for part ${i + 1}: ${s3Res.status} - ${errText}`);
            }
            log(`[Frame.io] Part ${i + 1} uploaded OK.`);
        }
    } finally {
        fs.closeSync(fd);
    }

    log(`[Frame.io] All parts uploaded. File is processing in Frame.io.`);

    // STEP 8: Create a public share link for the asset
    log(`[Frame.io] Creating public share link for asset ${fileAsset.id} in project ${projectId}...`, true);
    try {
        const shareRes = await frameioReq('POST', `/accounts/${accountId}/projects/${projectId}/shares`, {
            data: {
                type: 'asset',
                access: 'public',
                name: clipName,
                asset_ids: [fileAsset.id],
                downloading_enabled: true
            }
        });
        const shareData = shareRes.data;
        const shortUrl = shareData.short_url || '';
        log(`[Frame.io] Public Share URL Created: ${shortUrl}`, true);
        return shortUrl;
    } catch (e) {
        log(`[ERROR] Share creation failed: ${e.message}. The link in Google Sheets will be the private view_url.`, true);
        return fileAsset.view_url || '';
    }
}

// MODIFICATION: Added FTP upload logic
async function uploadThumbnailToFTP(thumbnailPath) {
    const client = new ftp.Client();
    // Force IPv4 to avoid the "::1" (localhost) resolution bug on Windows
    client.ftp.ipFamily = 4;

    try {
        const host = getEnv('FTP_HOST');
        const user = getEnv('FTP_USER');
        const pass = getEnv('FTP_PASS');

        if (!host || !user || !pass) {
            throw new Error(`Missing FTP credentials. Please contact administration.`);
        }

        log(`[FTP] Connecting to ${host}...`, true);

        await client.access({
            host: host,
            user: user,
            password: pass,
            secure: false
        });
        
        log(`[FTP] Logged in successfully.`, true);
        
        const remoteDir = "/www/domains/krutart.cz/wp-content/uploads/3212";
        log(`[FTP] Ensuring directory: ${remoteDir}`, true);
        await client.ensureDir(remoteDir);
        
        const filename = path.basename(thumbnailPath);
        log(`[FTP] Uploading ${filename} to ${remoteDir}`, true);
        await client.uploadFrom(thumbnailPath, filename);

        // Soft fail CHMODs in case Wedos FTP blocks the SITE command
        try { await client.send("SITE CHMOD 755 ."); } catch (e) { }
        try { await client.send(`SITE CHMOD 644 ${filename}`); } catch (e) { }
    } finally {
        client.close();
    }
}

// MODIFICATION: Added generic thumbnail extractor
function createThumbnail(ffmpegPath, filePath, time, outputPath) {
    const seekTime = Math.max(0, time);
    const args = [
        '-ss', seekTime.toString(), '-i', filePath,
        '-vf', 'scale=960:540:flags=lanczos+accurate_rnd,drawbox=x=88:y=ih-43:w=13:h=23:color=red:t=fill',
        '-vframes', '1', '-update', '1', '-y', outputPath
    ];
    return runFfmpeg(ffmpegPath, args);
}
function runFfmpeg(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
        const finalArgs = [...args];
        // If not in debug mode and no loglevel is specified, default to warning to reduce IPC flood
        if (!debugMode && !finalArgs.includes('-loglevel')) {
            finalArgs.unshift('-loglevel', 'warning');
        }

        log(`Running FFmpeg: ${path.basename(ffmpegPath)} ${finalArgs.join(' ')}`, true);
        const ffmpeg = spawn(ffmpegPath, finalArgs, { detached: process.platform !== 'win32' });
        currentFfmpegProcess = ffmpeg;
        let stderr = '';

        ffmpeg.stdout.on('data', (data) => log(`ffmpeg stdout: ${data}`));
        ffmpeg.stderr.on('data', (data) => {
            const str = data.toString();
            log(`ffmpeg stderr: ${str}`);
            stderr += str;
        });

        ffmpeg.on('close', (code) => {
            currentFfmpegProcess = null;
            if (processingState.shouldStop) {
                return reject(new Error('stopped'));
            }
            if (processingState.isPaused) {
                return reject(new Error('paused'));
            }
            if (code !== 0) {
                return reject(new Error(`FFmpeg process exited with code ${code}\n\nFFmpeg output:\n${stderr}`));
            }
            resolve();
        });

        ffmpeg.on('error', (err) => {
            currentFfmpegProcess = null;
            reject(err);
        });
    });
}