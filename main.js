// main.js - Main Electron process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');

let mainWindow;

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
            // If we encounter a quote, check if it's an escaped quote ("")
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

    // Normalize line endings and trim whitespace
    const text = csvString.trim().replace(/\r\n/g, '\n');

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (char === '"') {
            // Check for an escaped quote ("")
            if (inQuotes && text[i + 1] === '"') {
                i++; // Skip the second quote of the pair
            } else {
                inQuotes = !inQuotes;
            }
        }

        // A newline character is a row separator only if we're not inside quotes
        if (char === '\n' && !inQuotes) {
            rows.push(text.substring(currentRowStart, i));
            currentRowStart = i + 1;
        }
    }

    // Add the very last line if it exists
    if (currentRowStart < text.length) {
        rows.push(text.substring(currentRowStart));
    }

    return rows;
}


// Fetches and parses the Google Sheet data.
ipcMain.handle('fetch-sheet-data', () => {
    return new Promise((resolve, reject) => {
        const sheetUrl = 'https://docs.google.com/spreadsheets/d/1RC8PvCsNkDc3Tcsjp8Rqb4rKRbXXw_wtbGPy-r7A3-s/gviz/tq?tqx=out:csv&sheet=SHOT%20LIST';
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
                    
                    // Use the new robust line splitter instead of a simple split('\n')
                    const lines = splitCsvToLines(rawData);

                    // Handle potential UTF-8 BOM character at the start of the file
                    if (lines[0] && lines[0].charCodeAt(0) === 0xFEFF) {
                        lines[0] = lines[0].substring(1);
                    }

                    // The first row is the header row.
                    if (lines.length < 1) {
                        return reject(new Error('CSV data is empty. Cannot find header row.'));
                    }
                    const headerLine = lines.shift() || ''; // Get header and remove it from lines array

                    const headerNames = parseCsvLine(headerLine).map(h => h.replace(/^"|"$/g, '').trim());
                    log(`Using headers: [${headerNames.join(', ')}]`);

                    // Define the column names we need to find within the header row
                    const requiredShotIdHeader = 'SHOT ID';
                    const requiredEnviroHeader = 'ENVIRO';

                    // Find the index of our required columns using the parsed headers (case-insensitive)
                    const shotIdIndex = headerNames.findIndex(h => h.toUpperCase() === requiredShotIdHeader.toUpperCase());
                    const enviroIndex = headerNames.findIndex(h => h.toUpperCase() === requiredEnviroHeader.toUpperCase());

                    if (shotIdIndex === -1 || enviroIndex === -1) {
                        const missing = [];
                        if (shotIdIndex === -1) missing.push(`"${requiredShotIdHeader}"`);
                        if (enviroIndex === -1) missing.push(`"${requiredEnviroHeader}"`);
                        const errorMsg = `Could not find required columns ${missing.join(' or ')} in the sheet. The headers found were: [${headerNames.join(', ')}]`;
                        log(`[ERROR] ${errorMsg}`);
                        return reject(new Error(errorMsg));
                    }

                    const shotDataMap = {};
                    // Process the rest of the lines as data rows
                    lines.forEach((line, rowIndex) => {
                        // Trim whitespace from data columns, which is important for matching
                        const columns = parseCsvLine(line).map(c => c.replace(/^"|"$/g, '').trim());
                        
                        // Check if the row has enough columns before accessing by index
                        if (columns.length <= Math.max(shotIdIndex, enviroIndex)) {
                            // Don't log empty lines as warnings
                            if (line.trim() !== '') {
                                log(`[WARNING] Skipping row ${rowIndex + 2} due to insufficient columns: "${line}"`);
                            }
                            return; // continue to next iteration
                        }

                        const shotId = columns[shotIdIndex];
                        const enviro = columns[enviroIndex];
                        if (shotId) {
                            shotDataMap[shotId] = enviro || 'UNKNOWN'; // Default if empty
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


ipcMain.on('log', (event, message) => {
    console.log(message);
    const logPath = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${message}\n`);
});

ipcMain.on('analyze-videos', async (event, filePaths) => {
    log('--- Starting video analysis ---');
    const ffmpegPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(ffmpegPath)) {
        const errorMsg = 'FFmpeg executable not found for analysis!';
        log(errorMsg);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }
    
    let allChapters = [];
    for (const filePath of filePaths) {
        try {
            mainWindow.webContents.send('update-status', `Analyzing: ${path.basename(filePath)}`);
            const chapters = await getChapters(ffmpegPath, filePath);
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

ipcMain.on('process-videos', async (event, { chapters }) => {
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const ffmpegPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!fs.existsSync(ffmpegPath)) {
        const errorMsg = 'FFmpeg executable not found!';
        log(errorMsg);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }
    
    const videoInfos = {};
    for (const chapter of chapters) {
        if (!videoInfos[chapter.sourceFile]) {
            try {
                videoInfos[chapter.sourceFile] = await getVideoInfo(ffmpegPath, chapter.sourceFile);
            } catch (e) {
                log(`Failed to get video info for ${chapter.sourceFile}: ${e.message}`);
                mainWindow.webContents.send('processing-error', `Could not get info for ${chapter.sourceFile}`);
                return;
            }
        }
    }
    
    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const baseClipName = chapter.title.replace(/[ /\\?%*:|"<>]/g, '_');
        
        const videoSpecificOutputDir = path.join(outputDir, path.basename(chapter.sourceFile, path.extname(chapter.sourceFile)));
        if (!fs.existsSync(videoSpecificOutputDir)) {
            fs.mkdirSync(videoSpecificOutputDir, { recursive: true });
        }

        // Find the next available version number
        let version = 1;
        let finalClipName;
        while (true) {
            const versionString = `v${String(version).padStart(3, '0')}`;
            finalClipName = `${baseClipName}-${versionString}`;
            const prospectivePath = path.join(videoSpecificOutputDir, `${finalClipName}.mov`);
            if (!fs.existsSync(prospectivePath)) {
                break; // Found an available filename
            }
            version++;
        }
        log(`Assigning final name: ${finalClipName}`);

        mainWindow.webContents.send('chapter-update', {
            chapterId: chapter.id,
            status: 'Processing',
            message: `Processing: ${finalClipName}`,
            finalName: finalClipName // Pass the final name to the renderer
        });
        
        try {
            const videoInfo = videoInfos[chapter.sourceFile];
            const videoDuration = parseFloat(videoInfo.format.duration);
            const startTime = parseFloat(chapter.start_time);
            
            const nextChapterInFile = chapters.find((c, j) => j > i && c.sourceFile === chapter.sourceFile);
            const endTime = nextChapterInFile ? parseFloat(nextChapterInFile.start_time) : videoDuration;
            
            // Pass a new chapter object with the final, versioned title to the processing function
            const finalChapter = { ...chapter, title: finalClipName };
            await processSingleChapter(ffmpegPath, videoInfo, { ...finalChapter, startTime, endTime }, outputDir);
            
            mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Done' });

        } catch (error) {
            log(`[ERROR] Failed to process chapter ${finalClipName}. Error: ${error.message}`);
            mainWindow.webContents.send('chapter-update', { chapterId: chapter.id, status: 'Error' });
            mainWindow.webContents.send('processing-error', `Failed on chapter: ${finalClipName}`);
            return;
        }
    }

    mainWindow.webContents.send('processing-complete');
});


function log(message) {
    console.log(message);
    if (mainWindow) {
        mainWindow.webContents.send('log-message', message);
    }
    const logPath = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${message}\n`);
}

function getChapters(ffmpegPath, filePath) {
    return new Promise((resolve, reject) => {
        const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
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

async function processSingleChapter(ffmpegPath, videoInfo, chapter, outputDir) {
    const { sourceFile, title, startTime, endTime } = chapter;
    const clipName = title.replace(/[ /\\?%*:|"<>]/g, '_');
    log(`\n--- Processing Chapter: ${clipName} from ${path.basename(sourceFile)} ---`);
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
    
    const videoSpecificOutputDir = path.join(outputDir, path.basename(sourceFile, path.extname(sourceFile)));
    if (!fs.existsSync(videoSpecificOutputDir)) {
        fs.mkdirSync(videoSpecificOutputDir, { recursive: true });
    }

    const outputFilePath = path.join(videoSpecificOutputDir, `${clipName}.mov`);
    const prefixStillPath = path.join(videoSpecificOutputDir, `prefix_${clipName}.png`);
    const suffixStillPath = path.join(videoSpecificOutputDir, `suffix_${clipName}.png`);
    const metadataFilePath = path.join(videoSpecificOutputDir, `metadata_${clipName}.txt`);
    
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
        ffmpegArgs.push('-map_chapters', '3', '-c:v', 'prores_ks', '-profile:v', '3');
        if (hasAudio) ffmpegArgs.push('-c:a', 'pcm_s16le');
        ffmpegArgs.push('-y', outputFilePath);

        await runFfmpeg(ffmpegPath, ffmpegArgs);
        log(`--- Successfully created: ${outputFilePath} ---\n`);
    } finally {
        if (fs.existsSync(prefixStillPath)) fs.unlinkSync(prefixStillPath);
        if (fs.existsSync(suffixStillPath)) fs.unlinkSync(suffixStillPath);
        if (fs.existsSync(metadataFilePath)) fs.unlinkSync(metadataFilePath);
    }
}

function createStillFrame(ffmpegPath, filePath, time, outputPath) {
    const seekTime = Math.max(0, time);
    const args = ['-ss', seekTime.toString(), '-i', filePath, '-vframes', '1', '-y', outputPath];
    return runFfmpeg(ffmpegPath, args);
}

function getVideoInfo(ffmpegPath, filePath) {
    return new Promise((resolve, reject) => {
        const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
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
        const ffmpeg = spawn(ffmpegPath, args);
        ffmpeg.stdout.on('data', (data) => log(`ffmpeg stdout: ${data}`));
        ffmpeg.stderr.on('data', (data) => log(`ffmpeg stderr: ${data}`));
        ffmpeg.on('close', (code) => {
            if (code !== 0) return reject(new Error(`FFmpeg process exited with code ${code}`));
            resolve();
        });
        ffmpeg.on('error', (err) => reject(err));
    });
}
