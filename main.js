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

async function processSingleVideo(ffmpegPath, filePath, chapters, outputDir) {
    const videoInfo = await getVideoInfo(ffmpegPath, filePath);
    const frameRate = eval(videoInfo.streams[0].r_frame_rate);
    const frameDuration = 1 / frameRate;
    const tenFramesDuration = 10 * frameDuration;

    // Create a sub-directory for this specific video's output to avoid name collisions
    const videoSpecificOutputDir = path.join(outputDir, path.basename(filePath, path.extname(filePath)));
    if (!fs.existsSync(videoSpecificOutputDir)) {
        fs.mkdirSync(videoSpecificOutputDir, { recursive: true });
    }

    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const nextChapter = chapters[i + 1];
        const clipName = chapter.tags.title.replace(/ /g, '_');
        const outputFilePath = path.join(videoSpecificOutputDir, `${clipName}.mov`);

        const startTime = parseFloat(chapter.start_time);
        const endTime = nextChapter ? parseFloat(nextChapter.start_time) : parseFloat(videoInfo.format.duration);

        log(`Processing chapter: ${clipName} | Start: ${startTime} | End: ${endTime}`);

        const complexFilter = [];
        let inputCount = 1;

        // --- Video Prefix ---
        const prefixStillPath = path.join(videoSpecificOutputDir, `prefix_${clipName}.png`);
        await createStillFrame(ffmpegPath, filePath, startTime, prefixStillPath);
        complexFilter.push(`[${inputCount}:v]loop=loop=10:size=1:start=0,setpts=PTS-STARTPTS[pre_v]`);
        inputCount++;

        // --- Main Video Clip ---
        const mainClipFilter = `[0:v]trim=start=${startTime}:end=${endTime},setpts=PTS-STARTPTS[main_v]`;
        complexFilter.push(mainClipFilter);

        // --- Video Suffix ---
        const suffixStillPath = path.join(videoSpecificOutputDir, `suffix_${clipName}.png`);
        await createStillFrame(ffmpegPath, filePath, endTime - frameDuration, suffixStillPath);
        complexFilter.push(`[${inputCount}:v]loop=loop=10:size=1:start=0,setpts=PTS-STARTPTS[suf_v]`);
        inputCount++;

        // --- Audio Prefix ---
        let audioPrefixFilter = '';
        if (i > 0) { // Not the first clip
            const audioPrefixStartTime = Math.max(0, startTime - tenFramesDuration);
            audioPrefixFilter = `[0:a]atrim=start=${audioPrefixStartTime}:end=${startTime},asetpts=PTS-STARTPTS[pre_a];`;
            complexFilter.push(audioPrefixFilter);
        }

        // --- Main Audio Clip ---
        const mainAudioFilter = `[0:a]atrim=start=${startTime}:end=${endTime},asetpts=PTS-STARTPTS[main_a]`;
        complexFilter.push(mainAudioFilter);

        // --- Audio Suffix ---
        let audioSuffixFilter = '';
        if (i < chapters.length - 1) { // Not the last clip
            const audioSuffixEndTime = Math.min(parseFloat(videoInfo.format.duration), endTime + tenFramesDuration);
            audioSuffixFilter = `[0:a]atrim=start=${endTime}:end=${audioSuffixEndTime},asetpts=PTS-STARTPTS[suf_a];`;
            complexFilter.push(audioSuffixFilter);
        }

        // --- Concatenation ---
        const videoConcat = `[pre_v][main_v][suf_v]concat=n=3:v=1[out_v]`;
        complexFilter.push(videoConcat);

        let audioConcat = '';
        if (i > 0 && i < chapters.length - 1) {
            audioConcat = `[pre_a][main_a][suf_a]concat=n=3:v=0:a=1[out_a]`;
        } else if (i > 0) {
            audioConcat = `[pre_a][main_a]concat=n=2:v=0:a=1[out_a]`;
        } else if (i < chapters.length - 1) {
            audioConcat = `[main_a][suf_a]concat=n=2:v=0:a=1[out_a]`;
        } else {
            audioConcat = `[main_a]anull[out_a]`; // Just pass through main audio if no prefix/suffix
        }
        complexFilter.push(audioConcat);

        const ffmpegArgs = [
            '-i', filePath,
            '-i', prefixStillPath,
            '-i', suffixStillPath,
            '-filter_complex', complexFilter.join(';'),
            '-map', '[out_v]',
            '-map', '[out_a]',
            '-c:v', 'prores_ks', '-profile:v', '3',
            '-c:a', 'pcm_s16le',
            '-y',
            outputFilePath
        ];

        log(`Running FFmpeg command: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);

        await runFfmpeg(ffmpegPath, ffmpegArgs);
        log(`Successfully created: ${outputFilePath}`);

        // Cleanup still images
        fs.unlinkSync(prefixStillPath);
        fs.unlinkSync(suffixStillPath);
    }
}

function createStillFrame(ffmpegPath, filePath, time, outputPath) {
    const args = ['-ss', time, '-i', filePath, '-vframes', '1', '-y', outputPath];
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
