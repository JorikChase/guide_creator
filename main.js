// main.js - Main Electron process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

let mainWindow;

function createWindow() {
    // Determine the correct icon file based on the operating system
    const iconPath = path.join(__dirname, 'logo', process.platform === 'win32' ? 'logo.ico' : 'logo.icns');

    mainWindow = new BrowserWindow({
        width: 800,
        height: 700, // Increased height slightly for the new button
        icon: iconPath, // Set the platform-specific application icon
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            enableRemoteModule: false
        },
        frame: false, // Use a frameless window for custom title bar
    });

    mainWindow.loadFile('index.html');

    // Open DevTools for debugging
    // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- IPC Handlers ---

ipcMain.on('app:quit', () => {
    app.quit();
});

ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Movies', extensions: ['mov', 'qt'] }
        ]
    });
    if (canceled) {
        return;
    } else {
        return filePaths;
    }
});

ipcMain.handle('dialog:selectDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (canceled) {
        return;
    } else {
        return filePaths[0];
    }
});

ipcMain.on('log', (event, message) => {
    console.log(message);
    // You can also write to a log file here
    const logPath = path.join(app.getPath('userData'), 'app.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} - ${message}\n`);
});

ipcMain.on('process-videos', async (event, data) => {
    const { files: filePaths, outputDir } = data;
    if (!outputDir) {
        const errorMsg = 'No output directory selected!';
        log(errorMsg);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }

    const ffmpegPath = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    log(`Using ffmpeg at: ${ffmpegPath}`);

    if (!fs.existsSync(ffmpegPath)) {
        const errorMsg = 'FFmpeg executable not found!';
        log(errorMsg);
        dialog.showErrorBox('Error', errorMsg);
        mainWindow.webContents.send('processing-error', errorMsg);
        return;
    }

    for (const filePath of filePaths) {
        try {
            mainWindow.webContents.send('update-status', `Processing: ${path.basename(filePath)}`);
            const chapters = await getChapters(ffmpegPath, filePath);
            if (!chapters || chapters.length === 0) {
                log(`No chapters found in ${path.basename(filePath)}. Skipping.`);
                mainWindow.webContents.send('update-status', `No chapters found in ${path.basename(filePath)}. Skipping.`);
                continue;
            }

            await processSingleVideo(ffmpegPath, filePath, chapters, outputDir);
            mainWindow.webContents.send('update-status', `Finished processing: ${path.basename(filePath)}`);
        } catch (error) {
            log(`Error processing ${filePath}: ${error}`);
            mainWindow.webContents.send('processing-error', `Error processing ${filePath}: ${error.message}`);
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

// --- FFmpeg Logic ---

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
            if (code !== 0) {
                return reject(new Error(`ffprobe exited with code ${code}`));
            }
            try {
                const data = JSON.parse(output);
                resolve(data.chapters || []);
            } catch (e) {
                reject(new Error('Failed to parse ffprobe output.'));
            }
        });
    });
}

/**
 * Processes a single video file, splitting it by chapters and adding prefixes/suffixes.
 */
async function processSingleVideo(ffmpegPath, filePath, chapters, outputDir) {
    log(`[DEBUG] Starting processSingleVideo for: ${filePath}`);
    const videoInfo = await getVideoInfo(ffmpegPath, filePath);

    const videoStream = videoInfo.streams.find(s => s.codec_type === 'video');
    const audioStream = videoInfo.streams.find(s => s.codec_type === 'audio');
    const hasAudio = !!audioStream;
    log(`[DEBUG] Audio stream detected: ${hasAudio}`);

    if (!videoStream || !videoStream.r_frame_rate) {
        throw new Error('Could not determine frame rate for the video.');
    }
    
    const originalFrameRateString = videoStream.r_frame_rate;
    const frameRate = eval(originalFrameRateString);
    const frameDuration = 1 / frameRate;
    const tenFramesDuration = 10 * frameDuration;
    log(`[DEBUG] Video Info: FPS=${frameRate} (${originalFrameRateString}), Frame Duration=${frameDuration}s, 10-Frame Duration=${tenFramesDuration}s`);

    const videoDuration = parseFloat(videoInfo.format.duration);
    const videoSpecificOutputDir = path.join(outputDir, path.basename(filePath, path.extname(filePath)));
    if (!fs.existsSync(videoSpecificOutputDir)) {
        fs.mkdirSync(videoSpecificOutputDir, { recursive: true });
    }

    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const clipName = chapter.tags.title.replace(/[ /\\?%*:|"<>]/g, '_');
        log(`\n--- Processing Chapter ${i + 1}/${chapters.length}: ${clipName} ---`);

        const startTime = parseFloat(chapter.start_time);
        const endTime = (i < chapters.length - 1) ? parseFloat(chapters[i + 1].start_time) : videoDuration;
        log(`[DEBUG] Chapter Times: Start=${startTime}s, End=${endTime}s`);

        const outputFilePath = path.join(videoSpecificOutputDir, `${clipName}.mov`);
        const prefixStillPath = path.join(videoSpecificOutputDir, `prefix_${clipName}.png`);
        const suffixStillPath = path.join(videoSpecificOutputDir, `suffix_${clipName}.png`);
        const metadataFilePath = path.join(videoSpecificOutputDir, `metadata_${clipName}.txt`);

        try {
            log(`[DEBUG] Creating prefix still frame at ${startTime}s -> ${prefixStillPath}`);
            await createStillFrame(ffmpegPath, filePath, startTime, prefixStillPath);

            // Suffix frame is the last frame of the chapter
            const suffixTime = endTime - frameDuration;
            log(`[DEBUG] Creating suffix still frame at ${suffixTime}s -> ${suffixStillPath}`);
            await createStillFrame(ffmpegPath, filePath, suffixTime, suffixStillPath);

            // Create a metadata file with only the current chapter information
            const chapterDuration = endTime - startTime;
            const newChapterStartTime = tenFramesDuration; // Chapter starts after the prefix
            const newChapterEndTime = newChapterStartTime + chapterDuration;
            const timebase = 1000000; // Use microseconds for precision
            const metadataContent = `;FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/${timebase}\nSTART=${Math.round(newChapterStartTime * timebase)}\nEND=${Math.round(newChapterEndTime * timebase)}\ntitle=${chapter.tags.title}\n`;
            fs.writeFileSync(metadataFilePath, metadataContent);

            const complexFilterParts = [];
            
            // --- Video filters ---
            // Trim main video one frame short to avoid duplicating the last frame which is used for the suffix
            const videoTrimEndTime = Math.max(startTime, endTime - frameDuration);
            complexFilterParts.push(`[1:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[pre_v]`);
            complexFilterParts.push(`[0:v]trim=start=${startTime}:end=${videoTrimEndTime},setpts=PTS-STARTPTS[main_v]`);
            complexFilterParts.push(`[2:v]loop=loop=9:size=1:start=0,setpts=PTS-STARTPTS[suf_v]`);

            // --- Audio filters ---
            if (hasAudio) {
                const sampleRate = audioStream.sample_rate || '48000';
                const channelLayout = audioStream.channel_layout || 'stereo';
                const audioParts = [];

                // 1. Prefix Audio
                if (i === 0) {
                    // First chapter: Prepend 10 frames of silence to match the video prefix.
                    complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[pre_a]`);
                } else {
                    // Subsequent chapters: Use the last 10 frames of the previous section as a handle.
                    const audioPrefixStartTime = Math.max(0, startTime - tenFramesDuration);
                    complexFilterParts.push(`[0:a]atrim=start=${audioPrefixStartTime}:end=${startTime},asetpts=PTS-STARTPTS[pre_a]`);
                }
                audioParts.push('[pre_a]');

                // 2. Main Audio
                complexFilterParts.push(`[0:a]atrim=start=${startTime}:end=${endTime},asetpts=PTS-STARTPTS[main_a]`);
                audioParts.push('[main_a]');

                // 3. Suffix Audio
                if (i === chapters.length - 1) {
                    // Last chapter: Append 10 frames of silence.
                    complexFilterParts.push(`anullsrc=r=${sampleRate}:cl=${channelLayout},atrim=duration=${tenFramesDuration},asetpts=PTS-STARTPTS[suf_a]`);
                } else {
                    // Other chapters: Use the first 10 frames of the next section as a handle.
                    const audioSuffixEndTime = Math.min(videoDuration, endTime + tenFramesDuration);
                    complexFilterParts.push(`[0:a]atrim=start=${endTime}:end=${audioSuffixEndTime},asetpts=PTS-STARTPTS[suf_a]`);
                }
                audioParts.push('[suf_a]');
                
                // Concatenate all audio parts
                complexFilterParts.push(`${audioParts.join('')}concat=n=${audioParts.length}:v=0:a=1[out_a]`);
            }

            // --- Concatenate and Finalize ---
            complexFilterParts.push(`[pre_v][main_v][suf_v]concat=n=3:v=1,fps=${originalFrameRateString}[out_v]`);
            
            const filterComplexString = complexFilterParts.join(';');
            log(`[DEBUG] Filter_complex string: ${filterComplexString}`);

            const ffmpegArgs = [
                '-i', filePath,                                               // input 0: original video
                '-framerate', originalFrameRateString, '-i', prefixStillPath,  // input 1: prefix image
                '-framerate', originalFrameRateString, '-i', suffixStillPath,  // input 2: suffix image
                '-i', metadataFilePath,                                        // input 3: new chapter metadata
                '-filter_complex', filterComplexString,
                '-map', '[out_v]'
            ];
            
            if (hasAudio) {
                ffmpegArgs.push('-map', '[out_a]');
            }
        
            ffmpegArgs.push(
                '-map_chapters', '3', // Use chapters from metadata file (input 3)
                '-c:v', 'prores_ks', '-profile:v', '3'
            );
        
            if (hasAudio) {
                 ffmpegArgs.push('-c:a', 'pcm_s16le');
            }
        
            ffmpegArgs.push(
                '-y',
                outputFilePath
            );

            log(`Running FFmpeg command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);
            await runFfmpeg(ffmpegPath, ffmpegArgs);
            log(`--- Successfully created: ${outputFilePath} ---\n`);

        } catch (error) {
            log(`[ERROR] Failed to process chapter ${clipName}. Error: ${error.message}`);
            throw error;
        } finally {
            log(`[DEBUG] Cleaning up temporary files for ${clipName}`);
            if (fs.existsSync(prefixStillPath)) fs.unlinkSync(prefixStillPath);
            if (fs.existsSync(suffixStillPath)) fs.unlinkSync(suffixStillPath);
            if (fs.existsSync(metadataFilePath)) fs.unlinkSync(metadataFilePath);
        }
    }
}

function createStillFrame(ffmpegPath, filePath, time, outputPath) {
    const seekTime = Math.max(0, time);
    const args = ['-ss', seekTime.toString(), '-i', filePath, '-vframes', '1', '-y', outputPath];
    log(`[DEBUG] createStillFrame command: ${ffmpegPath} ${args.join(' ')}`);
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
            if (code !== 0) {
                return reject(new Error(`FFmpeg process exited with code ${code}`));
            }
            resolve();
        });
        ffmpeg.on('error', (err) => {
            reject(err);
        });
    });
}
