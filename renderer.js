// renderer.js
document.addEventListener('DOMContentLoaded', () => {
    const dragDropArea = document.getElementById('drag-drop-area');
    const browseBtn = document.getElementById('browse-btn');
    const processBtn = document.getElementById('process-btn');
    const closeBtn = document.getElementById('close-btn');
    const fileListDiv = document.getElementById('file-list');
    const statusDiv = document.getElementById('status');
    const logOutput = document.getElementById('log-output');
    const outputDirBtn = document.getElementById('output-dir-btn');
    const outputDirPath = document.getElementById('output-dir-path');
    const statusLogScrollContainer = document.querySelector('.status-log-scroll-container'); // Get the new scroll container

    let filePaths = [];
    let outputDir = null;

    function log(message) {
        console.log(message);
        window.electronAPI.log(message);
    }

    function checkCanProcess() {
        const canProcess = filePaths.length > 0 && outputDir;
        processBtn.disabled = !canProcess;
    }

    // --- Drag and Drop ---
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

    // --- Close Button ---
    closeBtn.addEventListener('click', () => {
        window.electronAPI.quitApp();
    });
    
    // --- Browse Button ---
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

    // --- Output Directory Button ---
    outputDirBtn.addEventListener('click', async () => {
        log("Opening directory selection dialog...");
        const selectedDir = await window.electronAPI.selectOutputDir();
        if (selectedDir) {
            outputDir = selectedDir;
            outputDirPath.textContent = outputDir;
            log(`Output directory selected: ${outputDir}`);
            checkCanProcess();
        } else {
            log("Directory selection canceled.");
        }
    });


    function addFiles(newFilePaths) {
        newFilePaths.forEach(path => {
            if (!filePaths.includes(path)) {
                filePaths.push(path);
            }
        });
        updateFileList();
    }

    function removeFile(pathToRemove) {
        filePaths = filePaths.filter(p => p !== pathToRemove);
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

        checkCanProcess();
    }

    // --- Process Button ---
    processBtn.addEventListener('click', () => {
        if (filePaths.length > 0 && outputDir) {
            log('Starting video processing...');
            statusDiv.textContent = 'Processing...';
            logOutput.textContent = '';
            processBtn.disabled = true;
            window.electronAPI.processVideos({ files: filePaths, outputDir: outputDir });
        } else {
             if (filePaths.length === 0) {
                log("Cannot process: No files have been added.");
            }
            if (!outputDir) {
                log("Cannot process: An output directory has not been selected.");
            }
        }
    });

    // --- IPC Listeners from Main ---
    window.electronAPI.onLogMessage((message) => {
        logOutput.textContent += message + '\n';
        // Scroll the new container to the bottom
        statusLogScrollContainer.scrollTop = statusLogScrollContainer.scrollHeight;
    });

    window.electronAPI.onUpdateStatus((status) => {
        statusDiv.textContent = status;
    });

    window.electronAPI.onProcessingComplete(() => {
        statusDiv.textContent = 'All videos processed successfully!';
        filePaths = [];
        outputDir = null;
        outputDirPath.textContent = 'No directory selected.';
        updateFileList();
    });
    
    window.electronAPI.onProcessingError((errorMsg) => {
        statusDiv.textContent = `Error: ${errorMsg}`;
        processBtn.disabled = false;
    });

});
