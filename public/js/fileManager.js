// ==========================================================================
// NexusFlow File Manager Frontend Controller
// ==========================================================================

(function() {
  // State
  let currentPhonePath = '/sdcard';
  let pathHistory = ['/sdcard'];
  let historyIndex = 0;
  let storageInfo = null;

  // File type icons
  const FILE_ICONS = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', bmp: '🖼️',
    mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬', '3gp': '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', m4a: '🎵',
    pdf: '📄', doc: '📝', docx: '📝', txt: '📝', rtf: '📝',
    xls: '📊', xlsx: '📊', csv: '📊', ppt: '📊', pptx: '📊',
    js: '💻', py: '💻', html: '💻', css: '💻', json: '💻', xml: '💻',
    zip: '📦', rar: '📦', tar: '📦', gz: '📦', '7z': '📦',
    apk: '📱', aab: '📱',
    folder: '📁', file: '📄'
  };

  // Initialize when DOM is ready
  function initFileManager() {
    const container = document.getElementById('tab-content-files');
    if (!container) return;

    // Lazy-load the file list the first time the FILES tab is opened.
    // Tab show/hide is owned by app.js's tabMap handler - we only add the
    // lazy-load side effect here (no class juggling = no double handler).
    const tabBtn = document.getElementById('tab-btn-files');
    if (tabBtn) {
      tabBtn.addEventListener('click', () => {
        if (!container.dataset.loaded) {
          container.dataset.loaded = 'true';
          loadFiles(currentPhonePath);
          loadStorageInfo();
        }
      });
    }

    // Setup drag & drop zone
    setupDragAndDrop();
    
    // Navigation buttons
    const btnBack = document.getElementById('fm-btn-back');
    const btnUp = document.getElementById('fm-btn-up');
    const btnRefresh = document.getElementById('fm-btn-refresh');
    
    if (btnBack) btnBack.addEventListener('click', navigateBack);
    if (btnUp) btnUp.addEventListener('click', navigateUp);
    if (btnRefresh) btnRefresh.addEventListener('click', () => loadFiles(currentPhonePath));
  }

  // Load files from phone path
  async function loadFiles(phonePath) {
    const fileList = document.getElementById('fm-file-list');
    const pathDisplay = document.getElementById('fm-current-path');
    
    if (!fileList) return;

    // Show loading
    fileList.innerHTML = '<div class="fm-loading"><div class="spinner"></div><span>SCANNING DEVICE...</span></div>';
    if (pathDisplay) pathDisplay.textContent = phonePath;

    try {
      const res = await fetch(`/api/files/list?path=${encodeURIComponent(phonePath)}`);
      const data = await res.json();

      if (data.success) {
        currentPhonePath = phonePath;
        renderFileList(data.files);
        updateNavigationState();
        
        // Log to terminal
        if (typeof appendTerminalLine === 'function') {
          appendTerminalLine(`[FILE MANAGER] Loaded ${data.files.length} items from ${phonePath}`, 'system');
        }
      } else {
        fileList.innerHTML = `<div class="fm-error">❌ ${data.error || 'Failed to load files'}</div>`;
      }
    } catch (error) {
      fileList.innerHTML = `<div class="fm-error">❌ Connection failed: ${error.message}</div>`;
    }
  }

  // Render file list
  function renderFileList(files) {
    const fileList = document.getElementById('fm-file-list');
    if (!fileList) return;

    if (files.length === 0) {
      fileList.innerHTML = '<div class="fm-empty">📂 This directory is empty</div>';
      return;
    }

    fileList.innerHTML = '';

    files.forEach(file => {
      const item = document.createElement('div');
      item.className = `fm-file-item ${file.isDirectory ? 'fm-directory' : 'fm-file'}`;
      
      const icon = FILE_ICONS[file.ext] || '📄';
      
      item.innerHTML = `
        <div class="fm-file-icon">${icon}</div>
        <div class="fm-file-info">
          <span class="fm-file-name" title="${file.path}">${file.name}</span>
          <span class="fm-file-meta">${file.isDirectory ? 'Directory' : file.sizeFormatted}</span>
        </div>
        <div class="fm-file-actions">
          ${!file.isDirectory ? `
            <button class="btn-icon fm-btn-download" data-path="${file.path}" title="Download to PC">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            </button>
          ` : ''}
          <button class="btn-icon fm-btn-delete" data-path="${file.path}" data-dir="${file.isDirectory}" data-name="${file.name}" title="Delete">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      `;

      // Click to open directory
      if (file.isDirectory) {
        item.addEventListener('dblclick', () => {
          pathHistory = pathHistory.slice(0, historyIndex + 1);
          pathHistory.push(file.path);
          historyIndex = pathHistory.length - 1;
          loadFiles(file.path);
        });
      }

      // Download button
      const downloadBtn = item.querySelector('.fm-btn-download');
      if (downloadBtn) {
        downloadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadFile(file.path, file.name);
        });
      }

      // Delete button
      const deleteBtn = item.querySelector('.fm-btn-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteFile(file.path, file.isDirectory, file.name);
        });
      }

      fileList.appendChild(item);
    });
  }

  // Download file from phone
  async function downloadFile(phonePath, fileName) {
    if (typeof appendTerminalLine === 'function') {
      appendTerminalLine(`[FILE MANAGER] Downloading: ${fileName}...`, 'adb-info');
    }
    if (typeof showToast === 'function') {
      showToast('FILE DOWNLOAD', `Pulling ${fileName} from device...`, 'warning');
    }

    try {
      const response = await fetch(`/api/files/download?path=${encodeURIComponent(phonePath)}`);
      
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);

        if (typeof appendTerminalLine === 'function') {
          appendTerminalLine(`[FILE MANAGER] Download complete: ${fileName}`, 'adb-success');
        }
        if (typeof showToast === 'function') {
          showToast('DOWNLOAD COMPLETE', `${fileName} saved to your PC.`, 'success');
        }
      } else {
        throw new Error('Download failed');
      }
    } catch (error) {
      if (typeof appendTerminalLine === 'function') {
        appendTerminalLine(`[FILE MANAGER] Download failed: ${error.message}`, 'adb-error');
      }
      if (typeof showToast === 'function') {
        showToast('DOWNLOAD FAILED', error.message, 'error');
      }
    }
  }

  // Delete file on phone
  async function deleteFile(filePath, isDirectory, fileName) {
    const ask = typeof confirmDialog === 'function'
      ? confirmDialog(`Delete "${fileName}" from your phone? This cannot be undone.`, { okText: 'Delete', danger: true })
      : Promise.resolve(window.confirm(`Delete "${fileName}"?`));
    if (!(await ask)) return;

    try {
      const res = await fetch('/api/files/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, isDirectory })
      });
      
      const result = await res.json();
      
      if (result.success) {
        if (typeof appendTerminalLine === 'function') {
          appendTerminalLine(`[FILE MANAGER] Deleted: ${fileName}`, 'adb-success');
        }
        if (typeof showToast === 'function') {
          showToast('FILE DELETED', `${fileName} removed from device.`, 'success');
        }
        loadFiles(currentPhonePath); // Refresh
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      if (typeof showToast === 'function') {
        showToast('DELETE FAILED', error.message, 'error');
      }
    }
  }

  // Setup drag and drop upload
  function setupDragAndDrop() {
    const dropZone = document.getElementById('fm-drop-zone');
    if (!dropZone) return;

    const fileInput = document.getElementById('fm-file-input');

    // Prevent defaults
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(event => {
      dropZone.addEventListener(event, (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    });

    // Highlight on drag
    ['dragenter', 'dragover'].forEach(event => {
      dropZone.addEventListener(event, () => {
        dropZone.classList.add('fm-drop-active');
      });
    });

    ['dragleave', 'drop'].forEach(event => {
      dropZone.addEventListener(event, () => {
        dropZone.classList.remove('fm-drop-active');
      });
    });

    // Handle drop
    dropZone.addEventListener('drop', (e) => {
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        uploadFiles(files);
      }
    });

    // Handle click to browse
    dropZone.addEventListener('click', () => {
      if (fileInput) fileInput.click();
    });

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          uploadFiles(e.target.files);
        }
        e.target.value = ''; // Reset
      });
    }
  }

  // Upload files to phone
  async function uploadFiles(fileList) {
    const progressBar = document.getElementById('fm-upload-progress');
    const progressFill = document.getElementById('fm-upload-progress-fill');
    const progressText = document.getElementById('fm-upload-progress-text');

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      
      if (typeof appendTerminalLine === 'function') {
        appendTerminalLine(`[FILE MANAGER] Uploading: ${file.name} (${formatSize(file.size)})...`, 'adb-info');
      }
      if (typeof showToast === 'function') {
        showToast('UPLOADING', `Pushing ${file.name} to device...`, 'warning');
      }

      // Show progress
      if (progressBar) progressBar.classList.remove('hidden');
      if (progressText) progressText.textContent = `Uploading ${file.name}...`;
      if (progressFill) progressFill.style.width = '30%';

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('destination', currentPhonePath);

        const res = await fetch('/api/files/upload', {
          method: 'POST',
          body: formData
        });

        const result = await res.json();

        if (progressFill) progressFill.style.width = '100%';

        if (result.success) {
          if (typeof appendTerminalLine === 'function') {
            appendTerminalLine(`[FILE MANAGER] Upload complete: ${file.name} → ${currentPhonePath}`, 'adb-success');
          }
          if (typeof showToast === 'function') {
            showToast('UPLOAD COMPLETE', `${file.name} pushed to ${currentPhonePath}`, 'success');
          }
        } else {
          throw new Error(result.error);
        }
      } catch (error) {
        if (typeof appendTerminalLine === 'function') {
          appendTerminalLine(`[FILE MANAGER] Upload failed: ${error.message}`, 'adb-error');
        }
        if (typeof showToast === 'function') {
          showToast('UPLOAD FAILED', error.message, 'error');
        }
      }
    }

    // Hide progress and refresh
    setTimeout(() => {
      if (progressBar) progressBar.classList.add('hidden');
      if (progressFill) progressFill.style.width = '0%';
      loadFiles(currentPhonePath);
    }, 1000);
  }

  // Load storage info
  async function loadStorageInfo() {
    try {
      const res = await fetch('/api/files/storage');
      const data = await res.json();
      
      if (data.success) {
        storageInfo = data;
        const storageBar = document.getElementById('fm-storage-fill');
        const storageText = document.getElementById('fm-storage-text');
        
        if (storageBar) {
          const percent = (data.usedBytes / data.totalBytes * 100).toFixed(1);
          storageBar.style.width = `${percent}%`;
        }
        if (storageText) {
          storageText.textContent = `${data.used} / ${data.total} (${data.usePercent} used)`;
        }
      }
    } catch (error) {
      // Silently fail
    }
  }

  // Navigation helpers
  function navigateBack() {
    if (historyIndex > 0) {
      historyIndex--;
      loadFiles(pathHistory[historyIndex]);
    }
  }

  function navigateUp() {
    const parentPath = currentPhonePath.split('/').slice(0, -1).join('/') || '/';
    pathHistory = pathHistory.slice(0, historyIndex + 1);
    pathHistory.push(parentPath);
    historyIndex = pathHistory.length - 1;
    loadFiles(parentPath);
  }

  function updateNavigationState() {
    const btnBack = document.getElementById('fm-btn-back');
    const btnUp = document.getElementById('fm-btn-up');
    
    if (btnBack) btnBack.disabled = historyIndex <= 0;
    if (btnUp) btnUp.disabled = currentPhonePath === '/';
  }

  // Format file size
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFileManager);
  } else {
    initFileManager();
  }
})();
