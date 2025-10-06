// main.js - Main Electron process

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// This is required for packages created with the squirrel maker.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');

const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbz9I11vPIkxX-mEyUk2tMLCSC01t9p4lFnTSaFbDTozIUlBTjMmuWtxzPspvTSitoIh/exec';

let mainWindow;

// --- State Management for Processing ---
let currentFfmpegProcess = null;
let processingState = {
    isProcessing: false,
    isPaused: false,
    shouldStop: false,
};

// --- Helper for binary paths ---
const isDev = !app.isPackaged;
const getBinaryPath = (binaryName) => {
    if (isDev) {
        // In development, assume 'bin' is in the project root
        return path.join(__dirname, 'bin', binaryName);
    }
    // In a packaged app, binaries are in the 'resources/bin' directory.
    // process.resourcesPath points to the 'resources' directory.
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
            if (inQuotes && line[i+1] === '"') {
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

// Fetches and parses the Google Sheet data.
ipcMain.handle('fetch-sheet-data', () => {
    return new Promise((resolve, reject) => {
        const sheetUrl = 'https://docs.google.com/spreadsheets/d/17W-uNf2bpFf2rhn1rCMgYEsBVbvr8UWpyJgHmJQ5gBw/gviz/tq?tqx=out:csv&sheet=guide_creator-export';
        log(`Fetching Google Sheet data from: ${sheetUrl}`);

        https.get(sheetUrl, (res) => {
            if (res.statusCode !== 200) {
                const errorMsg = `Google Sheet request failed with status code: ${res.statusCode}`;
                log(`[ERROR] ${errorMsg}`);
                return reject(new Error(errorMsg));
            }

            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { rawData += chunk; });
            res.on('end', () => {
                try {
                    log('Successfully fetched Google Sheet data. Parsing...');
                    
                    const lines = splitCsvToLines(rawData);

                    if (lines[0] && lines[0].charCodeAt(0) === 0xFEFF) {
                        lines[0] = lines[0].substring(1);
                    }

                    if (lines.length < 1) {
                        return reject(new Error('CSV data is empty. Cannot find header row.'));
                    }
                    const headerLine = lines.shift() || '';

                    const headerNames = parseCsvLine(headerLine).map(h => h.replace(/^"|"$/g, '').trim());
                    log(`Using headers: [${headerNames.join(', ')}]`);

                    const requiredIdHeader = 'ID';
                    const requiredGuideNameHeader = 'GUIDE_NAME';
                    const requiredPathHeader = 'PATH';

                    const idIndex = headerNames.findIndex(h => h.toUpperCase() === requiredIdHeader.toUpperCase());
                    const guideNameIndex = headerNames.findIndex(h => h.toUpperCase() === requiredGuideNameHeader.toUpperCase());
                    const pathIndex = headerNames.findIndex(h => h.toUpperCase() === requiredPathHeader.toUpperCase());

                    if (idIndex === -1 || guideNameIndex === -1 || pathIndex === -1) {
                        const missing = [];
                        if (idIndex === -1) missing.push(`"${requiredIdHeader}"`);
                        if (guideNameIndex === -1) missing.push(`"${requiredGuideNameHeader}"`);
                        if (pathIndex === -1) missing.push(`"${requiredPathHeader}"`);
                        const errorMsg = `Could not find required columns ${missing.join(', ')} in the sheet. Headers found: [${headerNames.join(', ')}]`;
                        log(`[ERROR] ${errorMsg}`);
                        return reject(new Error(errorMsg));
                    }

                    const shotDataMap = {};
                    lines.forEach((line, rowIndex) => {
                        const columns = parseCsvLine(line).map(c => c.replace(/^"|"$/g, '').trim());
                        
                        if (columns.length <= Math.max(idIndex, guideNameIndex, pathIndex)) {
                            if (line.trim() !== '') {
                                log(`[WARNING] Skipping row ${rowIndex + 2} due to insufficient columns: "${line}"`);
                            }
                            return;
                        }

                        const id = columns[idIndex];
                        const guideName = columns[guideNameIndex];
                        const pathValue = columns[pathIndex];
                        if (id) {
                            shotDataMap[id] = {
                                guideName: guideName || 'UNKNOWN_GUIDE_NAME',
                                path: pathValue || 'UNKNOWN_PATH'
                            };
                        }
                    });
                    log(`Parsed ${Object.keys(shotDataMap).length} data rows from the sheet.`);
                    resolve(shotDataMap);
                } catch (e) {
                    const errorMsg = `Failed to parse CSV data: ${e.message}`;
                    log(`[ERROR] ${errorMsg}`);
                    reject(new Error(errorMsg));
                }
            });
        }).on('error', (e) => {
            const errorMsg = `Got error during Google Sheet fetch: ${e.message}`;
            log(`[ERROR] ${errorMsg}`);
            reject(new Error(errorMsg));
        });
    });
});

ipcMain.on('update-sheet-data', (event, { originalTitle, dur_f, dur_s, guide_version }) => {
    if (!originalTitle) {
        log('[WARNING] update-sheet-data called without an originalTitle. Cannot update sheet.');
        return;
    }

    if (GOOGLE_APPS_SCRIPT_URL.includes('YOUR_DEPLOYMENT_ID')) {
        log(`[INFO] Skipping Google Sheet update for "${originalTitle}" because GOOGLE_APPS_SCRIPT_URL is not configured.`);
        return;
    }

    log(`Posting to Google Sheet for ID ${originalTitle}: DUR_F=${dur_f}, DUR_S=${dur_s}, GUIDE_V=${guide_version}`);

    const postData = JSON.stringify({
        id: originalTitle,
        dur_f: dur_f,
        dur_s: dur_s,
        guide_v: guide_version // <<< FIX: Changed 'GUIDE_V' to 'guide_v' to match Apps Script
    });
    
    const makeRequest = (url, method = 'POST', redirectCount = 0) => {
        if (redirectCount > 5) {
            log(`[ERROR] Exceeded max redirect limit for ID ${originalTitle}`);
            return;
        }

        const urlObject = new URL(url);
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json',
            }
        };

        if (method === 'POST') {
             options.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const req = https.request(urlObject, options, (res) => {
            // Handle redirects from Google Apps Script
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                log(`Google Sheet API Redirect [${res.statusCode}] for ID ${originalTitle}. Following to: ${res.headers.location}`);
                // Follow the redirect, but switch to GET as is standard for 302 redirects from a POST
                makeRequest(res.headers.location, 'GET', redirectCount + 1);
                res.resume(); // Consume the response data to free up memory
                return;
            }

            let responseBody = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                log(`Google Sheet API Final Response [${res.statusCode}] for ID ${originalTitle}: ${responseBody}`);
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    log(`[WARNING] Google Sheet update for ID ${originalTitle} may have failed with status ${res.statusCode}.`);
                }
            });
        });

        req.on('error', (e) => {
            log(`[ERROR] Problem with Google Sheet request for ID ${originalTitle}: ${e.message}`);
        });

        if (method === 'POST') {
            req.write(postData);
        }
        req.end();
    };

    makeRequest(GOOGLE_APPS_SCRIPT_URL);
});


ipcMain.on('log', (event, message) => {
    console.log(message);
    const logPath = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${message}\n`);
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
                id: `ch-${path.basename(filePath)}-${i}`, // Unique ID for UI tracking
                title: c.tags.title,
                start_time: c.start_time,
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

ipcMain.on('control-processing', (event, action) => {
    log(`[CONTROL] Received: ${action}`);
    if (action === 'pause') {
        processingState.isPaused = true;
        log('--- Processing Paused ---');
        mainWindow.webContents.send('update-status', 'Paused...');
    } else if (action === 'resume') {
        processingState.isPaused = false;
        log('--- Processing Resumed ---');
        mainWindow.webContents.send('update-status', 'Processing...');
    } else if (action === 'stop') {
        processingState.shouldStop = true;
        processingState.isPaused = false; // Release pause lock to allow loop to terminate
        if (currentFfmpegProcess) {
            log('--- User requested stop. Killing current FFmpeg process... ---');
            currentFfmpegProcess.kill('SIGKILL'); 
        } else {
            log('--- User requested stop. No active FFmpeg process to kill. The queue will stop. ---');
        }
    }
});

ipcMain.on('process-videos', async (event, { chapters }) => {
    const outputBaseDir = 's:\\'; 
    log(`--- Starting video processing. Base output directory: "${outputBaseDir}" ---`);
    
    const ffmpegPath = getBinaryPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const ffprobePath = getBinaryPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');

    if (!fs.existsSync(ffmpegPath) || !fs.existsSync(ffprobePath)) {
        const errorMsg = 'FFmpeg or FFprobe executables not found!';
        log(`[ERROR] FFmpeg path: ${ffmpegPath} (Exists: ${fs.existsSync(ffmpegPath)})`);
        log(`[ERROR] FFprobe path: ${ffprobePath} (Exists: ${fs.existsSync(ffprobePath)})`);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }
    
    // Reset state for this run
    processingState.isProcessing = true;
    processingState.isPaused = false;
    processingState.shouldStop = false;

    const videoInfos = {};
    for (const chapter of chapters) {
        if (processingState.shouldStop) break;
        if (!videoInfos[chapter.sourceFile]) {
            try {
                videoInfos[chapter.sourceFile] = await getVideoInfo(ffprobePath, chapter.sourceFile);
            } catch (e) {
                log(`Failed to get video info for ${chapter.sourceFile}: ${e.message}`);
                mainWindow.webContents.send('processing-error', `Could not get info for ${chapter.sourceFile}`);
                return;
            }
        }
    }
    
    for (let i = 0; i < chapters.length; i++) {
        if (processingState.shouldStop) {
            log('Processing loop stopped by user request.');
            break; 
        }

        while (processingState.isPaused) {
            if (processingState.shouldStop) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (processingState.shouldStop) {
            log('Processing loop stopped by user request after pause.');
            break;
        }

        const chapter = chapters[i];
        let finalClipName;
        
        let chapterOutputDir;
        if (chapter.path && chapter.path !== 'UNKNOWN_PATH' && chapter.path.trim() !== '') {
            const sanitizedPath = chapter.path.replace(/[:*?"<>|]/g, '');
            chapterOutputDir = path.join(outputBaseDir, sanitizedPath);
        } else {
            log(`[WARNING] Chapter "${chapter.title}" has an invalid or missing path. Saving to a fallback directory.`);
            const fallbackDirName = path.basename(chapter.sourceFile, path.extname(chapter.sourceFile));
            chapterOutputDir = path.join(outputBaseDir, '_UNMATCHED', fallbackDirName);
        }
        log(`Target directory for "${chapter.title}" is: "${chapterOutputDir}"`);

        try {
            fs.mkdirSync(chapterOutputDir, { recursive: true });
            log(`Ensured directory exists: "${chapterOutputDir}"`);
        } catch (error) {
            log(`[FATAL ERROR] Could not create directory "${chapterOutputDir}". Error: ${error.message}. Skipping this chapter.`);
            mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Error' });
            continue;
        }

        const baseClipName = chapter.title.replace(/[ /\\?%*:|"<>]/g, '_');
        let version = 1;
        while (true) {
            const versionString = `v${String(version).padStart(3, '0')}`;
            finalClipName = `${baseClipName}-${versionString}`;
            const prospectivePath = path.join(chapterOutputDir, `${finalClipName}.mp4`);
            if (!fs.existsSync(prospectivePath)) {
                break;
            }
            version++;
        }
        log(`Assigning final name: ${finalClipName}`);

        mainWindow.webContents.send('chapter-update', {
            chapterId: chapter.id,
            status: 'Processing',
            message: `Processing: ${finalClipName}`,
            finalName: finalClipName
        });
        
        try {
            const videoInfo = videoInfos[chapter.sourceFile];
            const videoDuration = parseFloat(videoInfo.format.duration);
            const startTime = parseFloat(chapter.start_time);
            
            const nextChapterInFile = chapters.find((c, j) => j > i && c.sourceFile === chapter.sourceFile);
            const endTime = nextChapterInFile ? parseFloat(nextChapterInFile.start_time) : videoDuration;
            
            const finalChapter = { ...chapter, title: finalClipName };
            const result = await processSingleChapter(ffmpegPath, ffprobePath, videoInfo, { ...finalChapter, startTime, endTime }, chapterOutputDir);
            
            log(`Chapter ${finalClipName} processed. DUR_S: ${result.durationSeconds}, DUR_F: ${result.durationFrames}, GUIDE_V: ${version}`);
            
            mainWindow.webContents.send('chapter-update', {
                chapterId: chapter.id,
                status: 'Done',
                durationSeconds: result.durationSeconds,
                durationFrames: result.durationFrames,
                guide_version: version
            });

        } catch (error) {
            if (processingState.shouldStop) {
                log(`Processing of chapter ${finalClipName} was intentionally stopped.`);
                mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Stopped' });
                break; 
            }
            log(`[ERROR] Failed to process chapter ${finalClipName}. Error: ${error.message}`);
            mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Error' });
        }
    }

    if (processingState.shouldStop) {
        log('--- Processing was stopped by the user. ---');
        mainWindow.webContents.send('processing-stopped');
    } else {
        log('--- All chapters have been processed. ---');
        mainWindow.webContents.send('processing-complete');
    }
    
    processingState.isProcessing = false;
    processingState.isPaused = false;
    processingState.shouldStop = false;
    currentFfmpegProcess = null;
});


function log(message) {
    console.log(message);
    if (mainWindow) {
        mainWindow.webContents.send('log-message', message);
    }
    const logPath = path.join(app.getPath('userData'), 'app.log');
    try {
        fs.appendFileSync(logPath, `${new Date().toISOString()} - ${message}\n`);
    } catch (error) {
        console.error("Failed to write to log file:", error);
    }
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
    const { sourceFile, title, startTime, endTime } = chapter;
    const clipName = title.replace(/[ /\\?%*:|"<>]/g, '_');
    log(`\n--- Processing Chapter: ${clipName} from ${path.basename(sourceFile)} ---`);
    log(`Output directory: ${chapterOutputDir}`);
    log(`[DEBUG] Chapter Times: Start=${startTime}s, End=${endTime}s`);

    const videoStream = videoInfo.streams.find(s => s.codec_type === 'video');
    const audioStream = videoInfo.streams.find(s => s.codec_type === 'audio');
    const hasAudio = !!audioStream;
    if (!videoStream || !videoStream.r_frame_rate) {
        throw new Error('Could not determine frame rate for the video.');
    }
    
    const originalFrameRateString = videoStream.r_frame_rate;
    const frameRate = eval(originalFrameRateString);
    const frameDuration = 1 / frameRate;
    const tenFramesDuration = 10 * frameDuration;
    
    const outputFilePath = path.join(chapterOutputDir, `${clipName}.mp4`);
    const prefixStillPath = path.join(chapterOutputDir, `prefix_${clipName}.png`);
    const suffixStillPath = path.join(chapterOutputDir, `suffix_${clipName}.png`);
    const metadataFilePath = path.join(chapterOutputDir, `metadata_${clipName}.txt`);
    
    try {
        await createStillFrame(ffmpegPath, sourceFile, startTime, prefixStillPath);
        const suffixTime = Math.max(startTime, endTime - frameDuration);
        await createStillFrame(ffmpegPath, sourceFile, suffixTime, suffixStillPath);

        const chapterDuration = endTime - startTime;
        const newChapterStartTime = tenFramesDuration;
        const newChapterEndTime = newChapterStartTime + chapterDuration;
        const timebase = 1000000;
        const metadataContent = `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/${timebase}\nSTART=${Math.round(newChapterStartTime * timebase)}\nEND=${Math.round(newChapterEndTime * timebase)}\ntitle=${title}\n`;
        fs.writeFileSync(metadataFilePath, metadataContent);

        const complexFilterParts = [];
        const videoTrimEndTime = Math.max(startTime, endTime - frameDuration);
        complexFilterParts.push(`[1:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[pre_v]`);
        complexFilterParts.push(`[0:v]trim=start=${startTime}:end=${videoTrimEndTime},setpts=PTS-STARTPTS[main_v]`);
        complexFilterParts.push(`[2:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[suf_v]`);

        if (hasAudio) {
            const sampleRate = audioStream.sample_rate || '48000';
            const channelLayout = audioStream.channel_layout || 'stereo';
            const audioParts = [];
            const isFirstChapterInFile = startTime < tenFramesDuration; 
            if (isFirstChapterInFile) {
                complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[pre_a]`);
            } else {
                const audioPrefixStartTime = Math.max(0, startTime - tenFramesDuration);
                complexFilterParts.push(`[0:a]atrim=start=${audioPrefixStartTime}:end=${startTime},asetpts=PTS-STARTPTS[pre_a]`);
            }
            audioParts.push('[pre_a]');

            complexFilterParts.push(`[0:a]atrim=start=${startTime}:end=${endTime},asetpts=PTS-STARTPTS[main_a]`);
            audioParts.push('[main_a]');

            const videoDuration = parseFloat(videoInfo.format.duration);
            const isLastChapterInFile = endTime > (videoDuration - frameDuration);
            if (isLastChapterInFile) {
                complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[suf_a]`);
            } else {
                const audioSuffixEndTime = Math.min(videoDuration, endTime + tenFramesDuration);
                complexFilterParts.push(`[0:a]atrim=start=${endTime}:end=${audioSuffixEndTime},asetpts=PTS-STARTPTS[suf_a]`);
            }
            audioParts.push('[suf_a]');
            
            complexFilterParts.push(`${audioParts.join('')}concat=n=${audioParts.length}:v=0:a=1[out_a]`);
        }

        complexFilterParts.push(`[pre_v][main_v][suf_v]concat=n=3:v=1,fps=${originalFrameRateString}[out_v]`);
        
        const filterComplexString = complexFilterParts.join(';');
        const ffmpegArgs = [
            '-i', sourceFile, '-framerate', originalFrameRateString, '-i', prefixStillPath,
            '-framerate', originalFrameRateString, '-i', suffixStillPath, '-i', metadataFilePath,
            '-filter_complex', filterComplexString, '-map', '[out_v]'
        ];
        if (hasAudio) ffmpegArgs.push('-map', '[out_a]');
        
        // --- START: ENCODING OPTIONS BASED ON MEDIAINFO ---
        ffmpegArgs.push(
            '-brand', 'mp42', // To get Codec ID: mp42
            '-map_chapters', '3',
            '-metadata', `creation_time=2025-09-08T10:10:38Z`,
            
            // Video options
            '-c:v', 'libx264',
            '-profile:v', 'main',
            '-level', '4.1',
            '-pix_fmt', 'yuv420p',
            '-refs', '3',
            '-b:v', '2465k',
            '-maxrate', '2694k',
            '-bufsize', '5388k', // Typically 2x maxrate
            '-g', '1', // GOP size from mediainfo (N=1)
            '-timecode', '10:00:08:17',
            '-metadata:s:v:0', 'handler_name=AVC Coding', // Set writing library
            '-metadata:s:v:0', 'language=eng'
        );

        // Audio options
        if (hasAudio) {
            ffmpegArgs.push(
                '-c:a', 'aac',
                '-b:a', '192k',
                '-ac', '2',
                '-ar', '48000',
                '-metadata:s:a:0', 'language=eng'
            );
        }
        // --- END: ENCODING OPTIONS ---

        ffmpegArgs.push('-y', outputFilePath);

        await runFfmpeg(ffmpegPath, ffmpegArgs);
        log(`--- Successfully created: ${outputFilePath} ---`);
        
        // Get the duration of the newly created clip for accurate logging
        log(`Getting duration for exported clip: ${path.basename(outputFilePath)}`);
        const newClipInfo = await getVideoInfo(ffprobePath, outputFilePath);
        const newClipVideoStream = newClipInfo.streams.find(s => s.codec_type === 'video');

        if (!newClipInfo.format || !newClipInfo.format.duration || !newClipVideoStream || !newClipVideoStream.r_frame_rate) {
            log('[WARNING] Could not get precise duration from the exported clip. Reporting as 0.');
            return { durationFrames: 0, durationSeconds: 0 };
        }

        const durationSecondsFloat = parseFloat(newClipInfo.format.duration);
        const newFrameRate = eval(newClipVideoStream.r_frame_rate);
        const durationFrames = Math.round(durationSecondsFloat * newFrameRate);
        const durationSeconds = Math.round(durationSecondsFloat);
        
        log(`Exported clip duration: ${durationSecondsFloat.toFixed(3)}s (${durationSeconds}s rounded), ${durationFrames} frames.`);

        return { durationFrames, durationSeconds };

    } finally {
        // Safely clean up temporary files
        log(`Cleaning up temporary files for ${clipName}...`);
        for (const file of [prefixStillPath, suffixStillPath, metadataFilePath]) {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                    log(`Deleted temp file: ${file}`);
                }
            } catch (error) {
                log(`[WARNING] Could not delete temporary file: ${file}. Error: ${error.message}`);
            }
        }
    }
}

function createStillFrame(ffmpegPath, filePath, time, outputPath) {
    const seekTime = Math.max(0, time);
    // Add a drawbox filter to place a filled red 50x50 square in the top-right corner.
    const args = [
        '-ss', seekTime.toString(),
        '-i', filePath,
        '-vf', 'drawbox=x=iw-w-10:y=10:w=50:h=50:color=red:t=fill',
        '-vframes', '1',
        '-y', outputPath
    ];
    return runFfmpeg(ffmpegPath, args);
}

function getVideoInfo(ffprobePath, filePath) {
    return new Promise((resolve, reject) => {
        const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath];
        log(`Running ffprobe: ${ffprobePath} ${args.join(' ')}`);

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

function runFfmpeg(ffmpegPath, args) {
    return new Promise((resolve, reject) => {
        log(`Running FFmpeg: ${ffmpegPath} ${args.join(' ')}`);
        const ffmpeg = spawn(ffmpegPath, args);
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
                return reject(new Error('FFmpeg process was stopped by the user.'));
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
