// renderer.js
document.addEventListener('DOMContentLoaded', () => {
    // --- Element Selectors ---
    const dragDropArea = document.getElementById('drag-drop-area');
    const browseBtn = document.getElementById('browse-btn');
    const closeBtn = document.getElementById('close-btn');
    const fileListDiv = document.getElementById('file-list');
    const statusDiv = document.getElementById('status');
    const logOutput = document.getElementById('log-output');
    const statusLogScrollContainer = document.querySelector('.status-log-scroll-container');
    const analyzeBtn = document.getElementById('analyze-btn');
    const chapterListDiv = document.getElementById('chapter-list');
    const processBtn = document.getElementById('process-btn');
    
    // --- State Variables ---
    let filePaths = [];
    let chapters = []; // To store the analyzed chapters

    /**
     * Compares a long string format "part1-name-part2" with a short one "part1-part2".
     *
     * @param {string} csvString - The string from the CSV, e.g., "sc01-alpha-sh010".
     * @param {string} localString - The local string to check against, e.g., "sc01-sh010".
     * @returns {boolean} - True if the first and last parts match, otherwise false.
     */
    function areStringsMatching(csvString, localString) {
        const parts = csvString.split('-');

        // Check if the string has at least a start and end part.
        // We use >= 2 because "sc01-sh010" would split into 2 parts.
        if (parts.length < 2) {
            return false;
        }

        // Construct the key from the first and last parts of the CSV string.
        // Using parts.length - 1 is robust and handles names with hyphens.
        const generatedKey = `${parts[0]}-${parts[parts.length - 1]}`;

        // Perform a direct, case-sensitive comparison.
        return generatedKey === localString;
    }

    function log(message) {
        console.log(message);
        window.electronAPI.log(message);
    }

    function updateButtonStates() {
        const hasFiles = filePaths.length > 0;
        const hasChapters = chapters.length > 0;
        
        analyzeBtn.disabled = !hasFiles;
        processBtn.disabled = !hasChapters;
    }

    // --- File Handling (Drag/Drop, Browse) ---
    dragDropArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDropArea.classList.add('drag-over');
    });

    dragDropArea.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDropArea.classList.remove('drag-over');
    });

    dragDropArea.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragDropArea.classList.remove('drag-over');

        const files = [...e.dataTransfer.files]
            .filter(file => {
                const lowerCaseName = file.name.toLowerCase();
                return lowerCaseName.endsWith('.mov') || lowerCaseName.endsWith('.qt');
            })
            .map(file => file.path);

        if(files.length > 0) {
            addFiles(files);
        } else {
            log("No valid QuickTime (.mov, .qt) files dropped.");
        }
    });
    
    browseBtn.addEventListener('click', async () => {
        log("Opening file dialog...");
        const selectedFiles = await window.electronAPI.openFileDialog();
        if (selectedFiles && selectedFiles.length > 0) {
            log(`Files selected: ${selectedFiles.join(', ')}`);
            addFiles(selectedFiles);
        } else {
            log("File selection canceled.");
        }
    });
    
    function addFiles(newFilePaths) {
        newFilePaths.forEach(path => {
            if (!filePaths.includes(path)) {
                filePaths.push(path);
            }
        });
        // Clear previous analysis results when new files are added
        chapters = [];
        chapterListDiv.innerHTML = '';
        updateFileList();
    }

    function removeFile(pathToRemove) {
        filePaths = filePaths.filter(p => p !== pathToRemove);
        // Clear previous analysis results if files change
        chapters = [];
        chapterListDiv.innerHTML = '';
        updateFileList();
    }

    function updateFileList() {
        fileListDiv.innerHTML = '';
        filePaths.forEach(path => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';

            const fileName = path.split(/[\\/]/).pop();
            fileItem.textContent = fileName;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '&times;';
            removeBtn.onclick = () => removeFile(path);

            fileItem.appendChild(removeBtn);
            fileListDiv.appendChild(fileItem);
        });

        updateButtonStates();
    }
    
    // --- Window Controls ---
    closeBtn.addEventListener('click', () => {
        window.electronAPI.quitApp();
    });

    // --- Core Actions ---
    analyzeBtn.addEventListener('click', () => {
        if (filePaths.length > 0) {
            log('Analyzing video files for chapters...');
            statusDiv.textContent = 'Analyzing...';
            analyzeBtn.disabled = true;
            processBtn.disabled = true;
            chapterListDiv.innerHTML = ''; // Clear previous list
            window.electronAPI.analyzeVideos(filePaths);
        }
    });

    processBtn.addEventListener('click', () => {
        if (chapters.length > 0) {
            log('Starting chapter processing...');
            statusDiv.textContent = 'Processing...';
            logOutput.textContent = '';
            processBtn.disabled = true;
            analyzeBtn.disabled = true;
            // The chapter titles are now base names; the main process will version them.
            window.electronAPI.processVideos({ chapters: chapters });
        } else {
            log("Cannot process: No chapters have been analyzed.");
        }
    });

    // --- IPC Listeners from Main Process ---
    window.electronAPI.onLogMessage((message) => {
        logOutput.textContent += message + '\n';
        statusLogScrollContainer.scrollTop = statusLogScrollContainer.scrollHeight;
    });

    window.electronAPI.onUpdateStatus((status) => {
        statusDiv.textContent = status;
    });

    window.electronAPI.onAnalyzeComplete(async (analysisResult) => {
        chapters = analysisResult;
        if (chapters.length === 0) {
            statusDiv.textContent = 'No chapters found in the selected files.';
            updateButtonStates();
            return;
        }
        
        statusDiv.textContent = `Found ${chapters.length} chapters. Fetching additional data from Google Sheets...`;
        log(`Found ${chapters.length} chapters locally. Now fetching Google Sheet data.`);
        chapterListDiv.innerHTML = ''; // Clear list while fetching

        try {
            const shotDataMap = await window.electronAPI.fetchSheetData();
            log('Successfully received shot data map from main process.');

            let renamedCount = 0;
            chapters.forEach(chapter => {
                const originalTitle = chapter.title; // e.g., "sc01-sh010"
                let baseTitle = originalTitle; // Default to original title
                
                let enviro = null;
                let matchingCsvKey = null;

                // Find the key in the sheet data that matches the chapter title's format.
                for (const csvKey in shotDataMap) {
                    if (areStringsMatching(csvKey, originalTitle)) {
                        enviro = shotDataMap[csvKey];
                        matchingCsvKey = csvKey;
                        break; // Found our match.
                    }
                }
                
                if (enviro) {
                    const titleParts = originalTitle.split('-');
                    if (titleParts.length === 2) {
                        const newTitle = `${titleParts[0]}-${enviro.replace(/\s+/g, '_')}-${titleParts[1]}`;
                        baseTitle = newTitle; // Update baseTitle if match is successful
                        chapter.originalTitle = matchingCsvKey; // Store the full original name from the sheet for reference
                        renamedCount++;
                        log(`Success: Matched chapter "${originalTitle}" with sheet row "${matchingCsvKey}". Base name is now "${baseTitle}".`);
                    } else {
                        log(`[ERROR] Chapter "${originalTitle}" matched, but its format is unexpected. Using original name.`);
                    }
                } else {
                    log(`[WARNING] No match found for chapter "${originalTitle}" in the Google Sheet. Using original name.`);
                }

                // Construct the base name for the chapter, without versioning.
                chapter.title = `3212-${baseTitle}-guide`;
                log(`Base name for chapter from "${originalTitle}" is set to "${chapter.title}".`);
            });


            statusDiv.textContent = `Renamed ${renamedCount} of ${chapters.length} chapters. Ready to process.`;
        } catch (error) {
            log(`[ERROR] Failed to fetch or process Google Sheet data: ${error.message}`);
            statusDiv.textContent = `Error fetching sheet data: ${error.message}. Using original names.`;
        }

        renderChapterList();
        updateButtonStates();
    });

    function renderChapterList() {
        chapterListDiv.innerHTML = '';
        chapters.forEach((chapter) => {
            const chapterItem = document.createElement('div');
            chapterItem.className = 'chapter-item';
            chapterItem.dataset.chapterId = chapter.id;

            const chapterName = document.createElement('span');
            chapterName.className = 'chapter-name';
            
            const filePrefix = filePaths.length > 1 ? `[${chapter.fileName.split(/[\\/]/).pop()}] ` : '';
            // Display the base name initially
            const displayName = chapter.title; 
            // Show full original name from sheet on hover if it was changed
            const hoverTitle = chapter.originalTitle ? `Original: ${chapter.originalTitle}` : displayName;
            
            chapterName.textContent = `${filePrefix}${displayName}`;
            chapterName.title = `${filePrefix}${hoverTitle}`;

            const chapterStatus = document.createElement('span');
            chapterStatus.className = 'chapter-status chapter-status-ready';
            chapterStatus.textContent = 'Ready';

            chapterItem.appendChild(chapterName);
            chapterItem.appendChild(chapterStatus);
            chapterListDiv.appendChild(chapterItem);
        });
    }

    window.electronAPI.onChapterUpdate((update) => {
        const chapterItem = chapterListDiv.querySelector(`[data-chapter-id="${update.chapterId}"]`);
        if (chapterItem) {
            const chapter = chapters.find(c => c.id === update.chapterId);

            // If the main process sends the final, versioned name, update the UI
            if (update.finalName && chapter) {
                const chapterNameEl = chapterItem.querySelector('.chapter-name');
                const filePrefix = filePaths.length > 1 ? `[${chapter.fileName.split(/[\\/]/).pop()}] ` : '';
                chapterNameEl.textContent = `${filePrefix}${update.finalName}`;
                // Also update the title in our local state so it's consistent
                chapter.title = update.finalName;
            }

            const statusEl = chapterItem.querySelector('.chapter-status');
            statusEl.textContent = update.status;
            statusEl.className = `chapter-status chapter-status-${update.status.toLowerCase()}`;
            
            if (update.message) {
                 statusDiv.textContent = update.message;
            }
        }
    });

    window.electronAPI.onProcessingComplete(() => {
        statusDiv.textContent = 'All chapters processed successfully!';
        filePaths = [];
        chapters = [];
        updateFileList();
        chapterListDiv.innerHTML = '';
        updateButtonStates();
    });
    
    window.electronAPI.onProcessingError((errorMsg) => {
        statusDiv.textContent = `Error: ${errorMsg}`;
        analyzeBtn.disabled = filePaths.length === 0;
        processBtn.disabled = chapters.length === 0;
    });
});
