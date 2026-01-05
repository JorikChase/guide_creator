// renderer.js
document.addEventListener('DOMContentLoaded', () => {
    // --- Element Selectors ---
    const dragDropArea = document.getElementById('drag-drop-area');
    const browseBtn = document.getElementById('browse-btn');
    const closeBtn = document.getElementById('close-btn');
    const fileListDiv = document.getElementById('file-list');
    const statusDiv = document.getElementById('status');
    const logOutput = document.getElementById('log-output');
    const analyzeBtn = document.getElementById('analyze-btn');
    const chapterListDiv = document.getElementById('chapter-list');
    const processBtn = document.getElementById('process-btn');
    const processingControls = document.getElementById('processing-controls');
    const pauseBtn = document.getElementById('pause-btn');
    const stopBtn = document.getElementById('stop-btn');
    const debugToggle = document.getElementById('debug-toggle');
    
    // --- State Variables ---
    let filePaths = [];
    let chapters = [];
    let isProcessing = false;

    function log(message) {
        console.log(message);
        window.electronAPI.log(message);
    }

    function updateButtonStates() {
        const hasFiles = filePaths.length > 0;
        const hasChapters = chapters.length > 0;
        const hasSelectedChapters = chapters.some(c => c.selected);
        
        analyzeBtn.disabled = !hasFiles || isProcessing;
        processBtn.disabled = !hasChapters || !hasSelectedChapters || isProcessing;
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
        chapters = [];
        chapterListDiv.innerHTML = '';
        updateFileList();
    }

    function removeFile(pathToRemove) {
        filePaths = filePaths.filter(p => p !== pathToRemove);
        chapters = [];
        chapterListDiv.innerHTML = '';
        if (filePaths.length === 0) {
            dragDropArea.classList.remove('shrunk');
        }
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
    
    // --- Window & App Controls ---
    closeBtn.addEventListener('click', () => {
        window.electronAPI.quitApp();
    });

    debugToggle.addEventListener('change', () => {
        const isEnabled = debugToggle.checked;
        log(`Debug mode toggled: ${isEnabled ? 'ON' : 'OFF'}`);
        window.electronAPI.toggleDebug(isEnabled);
    });

    // --- Core Actions ---
    analyzeBtn.addEventListener('click', () => {
        if (filePaths.length > 0) {
            log('Analyzing video files for chapters...');
            statusDiv.textContent = 'Analyzing...';
            analyzeBtn.disabled = true;
            processBtn.disabled = true;
            chapterListDiv.innerHTML = '';
            window.electronAPI.analyzeVideos(filePaths);
        }
    });

    processBtn.addEventListener('click', () => {
        const selectedChapters = chapters.filter(c => c.selected);
        if (selectedChapters.length > 0) {
            log(`Starting processing for ${selectedChapters.length} selected chapters...`);
            statusDiv.textContent = 'Processing...';
            logOutput.textContent = '';

            isProcessing = true;
            updateButtonStates();
            processBtn.classList.add('hidden');
            processingControls.classList.remove('hidden');
            pauseBtn.textContent = 'PAUSE';
            stopBtn.disabled = false;

            window.electronAPI.processVideos({ chapters: selectedChapters });
        } else {
            log("Cannot process: No chapters have been selected.");
        }
    });

    pauseBtn.addEventListener('click', () => {
        if (pauseBtn.textContent === 'PAUSE') {
            window.electronAPI.controlProcessing('pause');
            pauseBtn.textContent = 'RESUME';
        } else {
            window.electronAPI.controlProcessing('resume');
            pauseBtn.textContent = 'PAUSE';
        }
    });

    stopBtn.addEventListener('click', () => {
        log('Stop button clicked. Requesting to stop processing...');
        stopBtn.disabled = true; // Prevent multiple clicks
        window.electronAPI.controlProcessing('stop');
    });

    function resetProcessingUI() {
        isProcessing = false;
        processingControls.classList.add('hidden');
        processBtn.classList.remove('hidden');
        dragDropArea.classList.remove('shrunk');
        updateButtonStates();
    }

    // --- IPC Listeners from Main Process ---
    window.electronAPI.onLogMessage((message) => {
        logOutput.textContent += message + '\n';
        logOutput.scrollTop = logOutput.scrollHeight;
    });

    window.electronAPI.onUpdateStatus((status) => {
        statusDiv.textContent = status;
    });

    window.electronAPI.onAnalyzeComplete(async (analysisResult) => {
        chapters = analysisResult.map(chapter => ({ ...chapter, selected: true }));

        if (chapters.length > 0) {
            dragDropArea.classList.add('shrunk');
        }

        if (chapters.length === 0) {
            statusDiv.textContent = 'No chapters found in the selected files.';
            updateButtonStates();
            return;
        }
        
        statusDiv.textContent = `Found ${chapters.length} chapters. Fetching additional data from Google Sheets...`;
        log(`Found ${chapters.length} chapters locally. Now fetching Google Sheet data.`);
        chapterListDiv.innerHTML = '';

        try {
            const shotDataMap = await window.electronAPI.fetchSheetData();
            log('Successfully received shot data map from main process.');

            let renamedCount = 0;
            chapters.forEach(chapter => {
                const originalTitle = chapter.title;
                const sheetData = shotDataMap[originalTitle];
                
                if (sheetData) {
                    chapter.title = sheetData.guideName;
                    chapter.path = sheetData.path;
                    chapter.originalTitle = originalTitle;
                    renamedCount++;
                    log(`Success: Matched ID "${originalTitle}". New name is "${sheetData.guideName}".`);
                } else {
                    log(`[WARNING] No match found for ID "${originalTitle}" in the Google Sheet. Using original name.`);
                    chapter.originalTitle = originalTitle;
                }
            });

            statusDiv.textContent = `Found matches for ${renamedCount} of ${chapters.length} chapters. Ready to process.`;
        } catch (error) {
            log(`[ERROR] Failed to fetch or process Google Sheet data: ${error.message}`);
            statusDiv.textContent = `Error fetching sheet data: ${error.message}. Using original names.`;
        }

        renderChapterList();
        updateButtonStates();
    });

    function renderChapterList() {
        chapterListDiv.innerHTML = '';

        if (chapters.length === 0) return;

        // --- 1. Create Sticky Header Row (Select All) ---
        const headerItem = document.createElement('div');
        headerItem.className = 'chapter-list-header';

        const headerCheckboxContainer = document.createElement('label');
        headerCheckboxContainer.className = 'checkbox-container';
        
        const headerCheckbox = document.createElement('input');
        headerCheckbox.type = 'checkbox';
        // Check "Select All" box if ALL chapters are currently selected
        headerCheckbox.checked = chapters.every(c => c.selected);
        
        const headerCustomCheckbox = document.createElement('span');
        headerCustomCheckbox.className = 'custom-checkbox';
        headerCheckboxContainer.appendChild(headerCheckbox);
        headerCheckboxContainer.appendChild(headerCustomCheckbox);

        const headerLabel = document.createElement('span');
        headerLabel.textContent = 'SELECT / DESELECT ALL';
        headerLabel.style.flexGrow = '1'; // Occupy remaining space to be clickable

        // Toggle All Logic (attached to checkbox change)
        headerCheckbox.addEventListener('change', () => {
            const isChecked = headerCheckbox.checked;
            chapters.forEach(c => c.selected = isChecked);
            renderChapterList(); // Re-render to update all UI states
            updateButtonStates();
        });

        // Click anywhere on header to toggle
        headerItem.addEventListener('click', (e) => {
            // Avoid double-toggle if clicking the checkbox itself
            if (e.target.closest('.checkbox-container')) return;
            
            headerCheckbox.checked = !headerCheckbox.checked;
            // Trigger change event logic manually
            headerCheckbox.dispatchEvent(new Event('change'));
        });

        headerItem.appendChild(headerCheckboxContainer);
        headerItem.appendChild(headerLabel);
        chapterListDiv.appendChild(headerItem);


        // --- 2. Create Individual Chapter Rows ---
        chapters.forEach((chapter, index) => {
            const chapterItem = document.createElement('div');
            chapterItem.className = 'chapter-item';
            chapterItem.dataset.chapterId = chapter.id;
            
            if (!chapter.selected) {
                chapterItem.classList.add('unchecked');
            }

            // Checkbox
            const checkboxContainer = document.createElement('label');
            checkboxContainer.className = 'checkbox-container';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = chapter.selected;
            
            const customCheckbox = document.createElement('span');
            customCheckbox.className = 'custom-checkbox';
            checkboxContainer.appendChild(checkbox);
            checkboxContainer.appendChild(customCheckbox);

            // Info
            const chapterInfo = document.createElement('div');
            chapterInfo.className = 'chapter-info';
            const chapterName = document.createElement('span');
            chapterName.className = 'chapter-name';
            
            const filePrefix = filePaths.length > 1 ? `[${chapter.fileName.split(/[\\/]/).pop()}] ` : '';
            const displayName = chapter.title; 
            const hoverTitle = chapter.originalTitle ? `Original ID: ${chapter.originalTitle}` : displayName;
            
            chapterName.textContent = `${filePrefix}${displayName}`;
            chapterName.title = hoverTitle;

            const chapterPath = document.createElement('div');
            chapterPath.className = 'chapter-path';
            chapterPath.textContent = chapter.path || 'Path not available';

            chapterInfo.appendChild(chapterName);
            chapterInfo.appendChild(chapterPath);

            // Status
            const chapterStatus = document.createElement('span');
            chapterStatus.className = 'chapter-status chapter-status-ready';
            chapterStatus.textContent = 'Ready';

            // --- Logic: Update Header Checkbox ---
            function updateHeaderState() {
                const allSelected = chapters.every(c => c.selected);
                headerCheckbox.checked = allSelected;
            }

            // --- Logic: Row Click Event (Click Anywhere) ---
            chapterItem.addEventListener('click', (e) => {
                // If clicking the checkbox directly, let the change listener handle it
                if (e.target.closest('.checkbox-container')) return;

                // Toggle State
                chapter.selected = !chapter.selected;
                
                // Update UI Elements
                checkbox.checked = chapter.selected;
                chapterItem.classList.toggle('unchecked', !chapter.selected);
                
                updateHeaderState();
                updateButtonStates();
            });

            // --- Logic: Checkbox Click Event ---
            checkbox.addEventListener('change', () => {
                chapters[index].selected = checkbox.checked;
                chapterItem.classList.toggle('unchecked', !checkbox.checked);
                
                updateHeaderState();
                updateButtonStates();
            });

            chapterItem.appendChild(checkboxContainer);
            chapterItem.appendChild(chapterInfo);
            chapterItem.appendChild(chapterStatus);
            chapterListDiv.appendChild(chapterItem);
        });
    }

    window.electronAPI.onChapterUpdate((update) => {
        const chapterItem = chapterListDiv.querySelector(`[data-chapter-id="${update.chapterId}"]`);
        if (chapterItem) {
            const chapter = chapters.find(c => c.id === update.chapterId);
            if (!chapter) return;

            if (update.finalName) {
                const chapterNameEl = chapterItem.querySelector('.chapter-name');
                const filePrefix = filePaths.length > 1 ? `[${chapter.fileName.split(/[\\/]/).pop()}] ` : '';
                chapterNameEl.textContent = `${filePrefix}${update.finalName}`;
                chapter.title = update.finalName;
            }

            const statusEl = chapterItem.querySelector('.chapter-status');
            statusEl.textContent = update.status;
            statusEl.className = `chapter-status chapter-status-${update.status.toLowerCase()}`;
            
            if (update.message) {
                 statusDiv.textContent = update.message;
            }

            if (update.status === 'Done') {
                const durationEl = document.createElement('div');
                durationEl.className = 'chapter-duration';
                durationEl.textContent = `Duration: ${update.durationSeconds}s / ${update.durationFrames}f`;
                
                let chapterInfo = chapterItem.querySelector('.chapter-info');
                chapterInfo.appendChild(durationEl);

                if (chapter.originalTitle) {
                    log(`Chapter "${chapter.title}" finished. Sending data to Google Sheet for ID "${chapter.originalTitle}".`);
                    window.electronAPI.updateSheetData({
                        originalTitle: chapter.originalTitle,
                        dur_f: update.durationFrames,
                        dur_s: update.durationSeconds,
                        guide_version: update.guide_version
                    });
                } else {
                    log(`Chapter "${chapter.title}" finished, but has no originalTitle. Cannot update Google Sheet.`);
                }
            }
        }
    });

    window.electronAPI.onProcessingComplete(() => {
        statusDiv.textContent = 'All chapters processed successfully!';
        filePaths = [];
        chapters = [];
        updateFileList();
        chapterListDiv.innerHTML = '';
        resetProcessingUI();
    });

    window.electronAPI.onProcessingStopped(() => {
        statusDiv.textContent = 'Processing stopped by user.';
        log('UI updated after processing was stopped.');
        resetProcessingUI();
    });
    
    window.electronAPI.onProcessingError((errorMsg) => {
        statusDiv.textContent = `Error: ${errorMsg}`;
        resetProcessingUI();
    });
});