import JSZip from 'jszip';
import { getAllUserProjectsGenerator } from './api_user.js';
import { getProjectHtml } from './api_html.js';
import { getAssets, processAssets } from './api_assets.js';
import { getAllProjectRevisions, getProjectById, getProjectBySlug } from './api_project.js';
import { addToCatalog, isArchived, getCatalogAsArray, clearCatalog } from './catalog.js';

// --- State ---
const SETTINGS_KEY = 'websim_archiver_settings';
let isRunning = false;
let stopRequested = false;
let foundProjects = [];
let processedCount = 0;
let zip = null; // Used for Batch mode
let currentZipSize = 0;
let batchPart = 1;

const BATCH_SIZE_LIMIT = 450 * 1024 * 1024; // 450MB Limit for Batch Parts
const PROJECT_SPLIT_LIMIT = 300 * 1024 * 1024; // 300MB Limit for Single Project History Parts

// --- Zip Queue (Background Processing) ---
const zipQueue = {
    queue: [],
    processing: false,
    add: function(task, uiId) {
        this.queue.push({ task, uiId });
        this.process();
    },
    process: async function() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const { task, uiId } = this.queue.shift();
        
        try {
            if (uiId) updateStatus(uiId, 'loading', 'Zipping (BG)...');
            await task();
            if (uiId) updateStatus(uiId, 'done', 'Saved');
        } catch (e) {
            console.error("Background zip task failed", e);
            if (uiId) updateStatus(uiId, 'error', 'Zip Error');
        } finally {
            this.processing = false;
            setTimeout(() => this.process(), 200);
        }
    }
};

// --- DOM Elements ---
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('start-btn');
const resumeBtn = document.getElementById('resume-btn');
const stopBtn = document.getElementById('stop-btn');
const projectListEl = document.getElementById('project-list');
const statTotal = document.getElementById('stat-total');
const statProcessed = document.getElementById('stat-processed');
const statSize = document.getElementById('stat-size');

// Settings Elements
const dateStartInput = document.getElementById('date-start');
const dateEndInput = document.getElementById('date-end');
const downloadModeInput = document.getElementById('download-mode');
const delayInput = document.getElementById('delay-ms');
const skipForksInput = document.getElementById('skip-forks');
const includeHistoryInput = document.getElementById('include-history');
const skipArchivedInput = document.getElementById('skip-archived');

// History UI
const historyBtn = document.getElementById('history-btn');
const historyPanel = document.getElementById('history-panel');
const closeHistoryBtn = document.getElementById('close-history-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const historyListEl = document.getElementById('history-list');
const historyStatsEl = document.getElementById('history-stats');

// --- History Logic ---
const renderHistory = () => {
    const items = getCatalogAsArray();
    historyStatsEl.textContent = `${items.length} projects archived`;
    historyListEl.innerHTML = items.length === 0 
        ? '<div style="padding:2rem; text-align:center; color:var(--text-dim)">No history found.</div>' 
        : '';
    
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const dateStr = new Date(item.timestamp).toLocaleString();
        div.innerHTML = `
            <div class="history-item-info">
                <strong>${item.title}</strong>
                <span class="history-item-date">${item.username} / ${item.slug} • ${dateStr}</span>
            </div>
            <div class="status-icon done" style="width:20px; height:20px; font-size:0.7rem;">✓</div>
        `;
        historyListEl.appendChild(div);
    });
};

historyBtn.addEventListener('click', () => {
    renderHistory();
    historyPanel.classList.remove('hidden');
});

closeHistoryBtn.addEventListener('click', () => {
    historyPanel.classList.add('hidden');
});

clearHistoryBtn.addEventListener('click', () => {
    if(confirm('Clear all local download history? Processing will restart from scratch.')) {
        clearCatalog();
        renderHistory();
    }
});

// --- Resume Helper ---
const getResumeKey = (user) => `websim_archiver_resume_${user}`;

const checkResumeState = () => {
    const user = usernameInput.value.trim().replace('@', '');
    if (!user) {
        resumeBtn.style.display = 'none';
        return;
    }
    const raw = localStorage.getItem(getResumeKey(user));
    if (raw) {
        try {
            const data = JSON.parse(raw);
            if (data.cursor) {
                resumeBtn.style.display = 'inline-block';
                resumeBtn.textContent = `Resume (${data.processedCount || '?'} Done)`;
                return;
            }
        } catch(e) {}
    }
    resumeBtn.style.display = 'none';
};

const saveResumeState = (user, cursor, count) => {
    if (!user || !cursor) return;
    localStorage.setItem(getResumeKey(user), JSON.stringify({
        cursor,
        processedCount: count,
        timestamp: Date.now()
    }));
};

const clearResumeState = (user) => {
    localStorage.removeItem(getResumeKey(user));
    checkResumeState();
};

usernameInput.addEventListener('input', checkResumeState);
usernameInput.addEventListener('change', checkResumeState);

// --- Helpers ---
const generateGitRestoreScript = () => {
    return `#!/bin/bash
set -e

# WebSim Project Restoration Script
# Generated by WebSim Archiver

if [ -d ".git" ]; then
    echo "Error: .git directory already exists. Please run this in an empty folder or clean it first."
    exit 1
fi

echo "Initializing Git Repository..."
git init -b main

# Check for commit log
if [ ! -f "commit_log.txt" ]; then
    echo "Error: commit_log.txt not found."
    exit 1
fi

TOTAL_VERSIONS=$(wc -l < commit_log.txt)
CURRENT=0

echo "Found $TOTAL_VERSIONS versions to restore."

while IFS="|" read -r ver date author msg; do
    CURRENT=$((CURRENT+1))
    echo "[git-restore] Processing Version \${ver} (\${CURRENT}/\${TOTAL_VERSIONS})..."
    
    # 1. Clean working directory safely
    # Removes everything except .git, revisions, scripts, and logs
    find . -maxdepth 1 -not -name '.git' -not -name 'revisions' -not -name 'restore_git.sh' -not -name 'commit_log.txt' -not -name '.' -not -name '..' -exec rm -rf {} +
    
    # 2. Copy files from revision snapshot
    if [ -d "revisions/\${ver}" ]; then
        # Copy hidden files too if they exist, suppress error if empty
        cp -a "revisions/\${ver}/." . 2>/dev/null || true
    else
        echo "Warning: Revision \${ver} data not found, skipping files..."
    fi
    
    # 3. Git Commit
    git add .
    
    # Check for changes
    if git diff --cached --quiet; then
        echo "  - No changes detected (empty commit)."
        GIT_AUTHOR_DATE="\${date}" GIT_COMMITTER_DATE="\${date}" git commit --allow-empty -m "Version \${ver}: \${msg} (No Changes)" --author="\${author} <\${author}@websim.ai>" --quiet
    else
        GIT_AUTHOR_DATE="\${date}" GIT_COMMITTER_DATE="\${date}" git commit -m "Version \${ver}: \${msg}" --author="\${author} <\${author}@websim.ai>" --quiet
    fi
    
done < commit_log.txt

echo "----------------------------------------"
echo "Restoration Complete!"
echo "You can now delete the 'revisions' folder, 'commit_log.txt', and 'restore_git.sh'."
`;
};

const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const createProjectElement = (project) => {
    // Robust fallback for project properties
    const safeTitle = project.title || project.name || project.slug || project.id || 'Untitled';
    const safeSlug = project.slug || project.id;
    const safeId = project.id;

    const el = document.createElement('div');
    el.className = 'project-item';
    el.id = `proj-${safeId}`;
    el.innerHTML = `
        <div class="status-icon pending" id="icon-${safeId}">●</div>
        <div class="project-info">
            <span class="project-name">${safeTitle}</span>
            <div class="project-meta">
                <span>/${safeSlug}</span>
                <span id="log-${safeId}" class="log-msg">Waiting...</span>
            </div>
        </div>
    `;
    return el;
};

const updateStatus = (projectId, status, msg) => {
    const icon = document.getElementById(`icon-${projectId}`);
    const log = document.getElementById(`log-${projectId}`);
    if (!icon || !log) return;

    // Reset classes
    icon.className = 'status-icon';
    if (status === 'loading') icon.classList.add('loading');
    else if (status === 'done') icon.classList.add('done');
    else if (status === 'error') icon.classList.add('error');
    else icon.classList.add('pending');

    icon.textContent = status === 'done' ? '✓' : (status === 'error' ? '!' : '●');
    log.textContent = msg;
};

// --- Core Logic ---

async function processProject(project, username, options) {
    if (stopRequested) return;
    
    const { mode, rootZipFolder, includeHistory } = options;
    const uiId = project.id; 
    let projectSizeEstimate = 0;

    console.log(`[Main] Processing project: ${project.id} (slug: ${project.slug})`);
    
    try {
        const projectFolderName = project.slug || project.id || `project_${project.id}`;
        
        // --- PATH 1: Full History ---
        if (includeHistory) {
            updateStatus(uiId, 'loading', 'Fetching revisions...');
            
            // 1. Get All Revisions
            let revisions = await getAllProjectRevisions(project.id);
            if (!revisions || revisions.length === 0) {
                const fallbackVer = project.current_version || project.latest_version?.version || 1;
                revisions = [{
                    id: project.current_revision?.id, version: fallbackVer,
                    created_at: project.created_at, created_by: project.created_by
                }];
            }
            revisions.sort((a, b) => (a.version || 0) - (b.version || 0));
            
            // Dedupe
            const uniqueRevisions = [];
            const seenVersions = new Set();
            for (const r of revisions) {
                if (!seenVersions.has(r.version)) {
                    seenVersions.add(r.version);
                    uniqueRevisions.push(r);
                }
            }
            revisions = uniqueRevisions;

            console.log(`[History] Found ${revisions.length} revs for ${project.slug}`);
            
            // --- History Splitting Setup ---
            let currentHistoryZip = mode === 'individual' ? new JSZip() : rootZipFolder;
            let currentHistorySize = 0;
            let partNumber = 1;
            let commitLog = "";
            
            // Helper to Flush Part (Individual Mode Only)
            const flushPart = async (isFinal = false) => {
                if (mode !== 'individual') return; 
                
                const suffix = (partNumber === 1 && isFinal) ? '' : `_part${partNumber}`;
                const zipToSave = currentHistoryZip;
                const pNum = partNumber;
                
                // Offload zipping to queue
                zipQueue.add(async () => {
                    console.log(`[ZipQueue] Starting zip for ${project.slug} (Part ${pNum})...`);
                    const blob = await zipToSave.generateAsync({ type: "blob" });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${username}_${projectFolderName}${suffix}.zip`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                }, isFinal ? uiId : null); // Only update UI to 'Done' on final part

                if (!isFinal) {
                    partNumber++;
                    currentHistoryZip = new JSZip();
                    currentHistorySize = 0;
                }
            };

            // 3. Loop Revisions
            for (let i = 0; i < revisions.length; i++) {
                if (stopRequested) throw new Error("Stopped by user");
                
                const rev = revisions[i];
                let vNum = rev.version ?? rev.revision_number ?? (i + 1);
                
                updateStatus(uiId, 'loading', `Archiving Rev ${vNum} (${i+1}/${revisions.length})`);
                
                let success = false;
                let attempts = 0;
                while (!success && attempts < 3) {
                    attempts++;
                    try {
                        const assetList = await getAssets(project.id, vNum);
                        const htmlContent = await getProjectHtml(project.id, vNum);
                        const files = await processAssets(assetList, project.id, vNum);
                        
                        if (htmlContent) files['index.html'] = new TextEncoder().encode(htmlContent);
                        else if (!files['index.html']) files['index.html'] = new TextEncoder().encode(`<!-- Version ${vNum}: Missing -->`);

                        // Determine folder path
                        const baseFolder = mode === 'individual' 
                            ? currentHistoryZip.folder('revisions').folder(String(vNum))
                            : rootZipFolder.folder(projectFolderName).folder('revisions').folder(String(vNum));

                        // Write Files & Calc Size
                        let revSize = 0;
                        for (const [path, content] of Object.entries(files)) {
                            baseFolder.file(path.replace(/^\/+/, ''), content);
                            revSize += content.byteLength;
                        }
                        
                        currentHistorySize += revSize;
                        projectSizeEstimate += revSize;
                        if (mode === 'batch') currentZipSize += revSize;

                        // Log
                        const date = rev.created_at || new Date().toISOString();
                        const author = rev.created_by?.username || username || 'unknown';
                        const msg = (rev.title || rev.note || rev.description || `Version ${vNum}`).replace(/[\r\n|]+/g, ' ');
                        commitLog += `${vNum}|${date}|${author}|${msg}\n`;
                        
                        success = true;

                        // Check Split Limit (Individual Mode Only)
                        if (mode === 'individual' && currentHistorySize > PROJECT_SPLIT_LIMIT) {
                            console.log(`[Main] ✂️ Splitting history for ${project.slug} at rev ${vNum}`);
                            currentHistoryZip.file("commit_log_part.txt", commitLog);
                            await flushPart(false);
                        }

                    } catch (revError) {
                         console.error(`[History] ⚠️ Rev ${vNum} failed:`, revError);
                         if (attempts >= 3) commitLog += `${vNum}|${new Date().toISOString()}|system|FAILED\n`;
                         else await new Promise(r => setTimeout(r, 1000 * attempts));
                    }
                }
            }
            
            // Finalize
            if (mode === 'individual') {
                currentHistoryZip.file("commit_log.txt", commitLog);
                currentHistoryZip.file("restore_git.sh", generateGitRestoreScript(), { unixPermissions: "755" });
                await flushPart(true);
            } else {
                 // Batch mode
                 const pFolder = rootZipFolder.folder(projectFolderName);
                 pFolder.file("commit_log.txt", commitLog);
                 pFolder.file("restore_git.sh", generateGitRestoreScript(), { unixPermissions: "755" });
                 updateStatus(uiId, 'done', 'Packaged');
            }

        } else {
            // --- PATH 2: Latest Only ---
            updateStatus(uiId, 'loading', 'Fetching latest...');
            
            let versionId = project.current_version ?? project.latest_revision?.version ?? project.revision?.version;
            if (versionId == null) {
                 try {
                     const full = await getProjectById(project.id);
                     versionId = full?.current_version;
                     if (versionId == null) versionId = (await getAllProjectRevisions(project.id))?.[0]?.version;
                 } catch(e){}
            }
            if (versionId == null) throw new Error('No numeric version found');

            const [assetList, htmlContent] = await Promise.all([
                getAssets(project.id, versionId),
                getProjectHtml(project.id, versionId)
            ]);

            const files = await processAssets(assetList, project.id, versionId);
            const htmlBuffer = htmlContent ? new TextEncoder().encode(htmlContent) : new TextEncoder().encode(`<!-- Source missing -->`);
            files['index.html'] = htmlBuffer;

            // Prepare Zip
            const target = mode === 'individual' ? new JSZip() : rootZipFolder.folder(projectFolderName);
            
            let size = 0;
            for (const [path, content] of Object.entries(files)) {
                target.file(path.replace(/^\/+/, ''), content);
                size += content.byteLength;
            }
            
            if (mode === 'batch') {
                currentZipSize += size;
                updateStatus(uiId, 'done', 'Packaged');
            } else {
                // Individual Mode - Queue zipping
                updateStatus(uiId, 'loading', 'Queued for Zip');
                zipQueue.add(async () => {
                    const blob = await target.generateAsync({ type: "blob" });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${username}_${projectFolderName}.zip`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                }, uiId);
            }
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        addToCatalog(project);

    } catch (e) {
        console.error(`[Main] Error processing ${project.slug}:`, e);
        updateStatus(uiId, 'error', `Failed: ${e.message}`);
    }
}

function saveSettings() {
    const settings = {
        username: usernameInput.value,
        dateStart: dateStartInput.value,
        dateEnd: dateEndInput.value,
        downloadMode: downloadModeInput.value,
        delay: delayInput.value,
        skipForks: skipForksInput.checked,
        includeHistory: includeHistoryInput.checked,
        skipArchived: skipArchivedInput.checked
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch(e){}
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.username) usernameInput.value = s.username;
        if (s.dateStart) dateStartInput.value = s.dateStart;
        if (s.dateEnd) dateEndInput.value = s.dateEnd;
        if (s.downloadMode) downloadModeInput.value = s.downloadMode;
        if (s.delay) delayInput.value = s.delay;
        if (s.skipForks !== undefined) skipForksInput.checked = s.skipForks;
        if (s.includeHistory !== undefined) includeHistoryInput.checked = s.includeHistory;
        if (s.skipArchived !== undefined) skipArchivedInput.checked = s.skipArchived;
    } catch(e) {
        console.warn("Failed to load settings", e);
    }
}

async function startBackup(isResume = false) {
    saveSettings();
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) return alert('Please enter a username');

    // Read Settings
    const mode = downloadModeInput.value;
    const delay = parseInt(delayInput.value) || 3000;
    const skipForks = skipForksInput.checked;
    const includeHistory = includeHistoryInput.checked;
    const skipArchived = skipArchivedInput.checked;
    
    const startDate = dateStartInput.value ? new Date(dateStartInput.value) : null;
    const endDate = dateEndInput.value ? new Date(dateEndInput.value) : null;

    console.log(`[Main] Backup config: User=${username}, Mode=${mode}, Delay=${delay}, SkipForks=${skipForks}`);

    // Reset UI & Resume Logic
    isRunning = true;
    stopRequested = false;
    foundProjects = [];
    batchPart = 1;
    currentZipSize = 0;
    
    let startCursor = null;

    if (isResume) {
        const resumeData = JSON.parse(localStorage.getItem(getResumeKey(username)) || '{}');
        if (resumeData.cursor) {
            startCursor = resumeData.cursor;
            processedCount = resumeData.processedCount || 0;
            console.log(`[Main] Resuming from cursor: ${startCursor} (Previously processed: ${processedCount})`);
        }
    } else {
        processedCount = 0;
        clearResumeState(username);
        projectListEl.innerHTML = '';
        statTotal.textContent = '0';
        statProcessed.textContent = '0';
        statSize.textContent = '0 Bytes';
    }

    zip = new JSZip();

    startBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = (mode === 'batch') ? "Stop & Save" : "Stop";
    usernameInput.disabled = true;

    try {
        const onCursorSaved = (nextCursor) => {
            saveResumeState(username, nextCursor, processedCount);
        };

        const generator = getAllUserProjectsGenerator(username, startCursor, onCursorSaved);
        
        for await (const project of generator) {
            if (stopRequested) break;

            // --- FILTERING LOGIC ---
            if (startDate || endDate) {
                const pDate = new Date(project.created_at);
                if (startDate && pDate < startDate) continue;
                if (endDate && pDate > endDate) continue;
            }

            if (skipForks && project.parent_id) {
                console.log(`[Main] Skipping fork: ${project.slug}`);
                continue;
            }

            foundProjects.push(project);
            statTotal.textContent = foundProjects.length;
            
            const el = createProjectElement(project);
            projectListEl.appendChild(el);

            if (!project.id) {
                updateStatus('unknown', 'error', 'Missing ID');
                continue;
            }

            if (skipArchived && isArchived(project.id)) {
                updateStatus(project.id, 'done', 'Skipped (Archived)');
                continue;
            }

            // --- Batch Splitting Logic ---
            if (mode === 'batch' && currentZipSize > BATCH_SIZE_LIMIT) {
                console.log(`[Main] 📦 Batch limit reached (${formatBytes(currentZipSize)}). Saving Part ${batchPart}...`);
                
                const saveLabel = `Saving Part ${batchPart}...`;
                const oldText = startBtn.textContent;
                startBtn.textContent = saveLabel;
                updateStatus(project.id, 'pending', 'Waiting for Batch Split...');

                const content = await zip.generateAsync({ type: "blob" });
                
                const a = document.createElement('a');
                a.href = URL.createObjectURL(content);
                a.download = `${username}_backup_part${batchPart}.zip`;
                a.click();
                URL.revokeObjectURL(a.href);
                
                batchPart++;
                zip = new JSZip(); 
                currentZipSize = 0;
                startBtn.textContent = oldText;
                
                await new Promise(r => setTimeout(r, 1000));
            }

            // Get Fresh User Folder (Linked to Current Zip)
            const currentUserFolder = zip.folder(username);

            // Process
            await processProject(project, username, {
                mode: mode,
                rootZipFolder: currentUserFolder,
                includeHistory: includeHistory
            });
            
            // Rate Limit
            if (delay > 0) {
                await new Promise(r => setTimeout(r, delay));
            }
        }

    } catch (e) {
        console.error("[Main] Loop error:", e);
        // Add visual error to top of list
        const errDiv = document.createElement('div');
        errDiv.className = 'project-item';
        errDiv.style.borderColor = 'var(--error)';
        errDiv.innerHTML = `<div class="status-icon error">!</div> <div><strong>Scan Stopped</strong><br>Error: ${e.message}</div>`;
        projectListEl.prepend(errDiv);
    } finally {
        finishBackup(mode);
    }
}

resumeBtn.addEventListener('click', () => startBackup(true));

async function finishBackup(mode) {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.textContent = "Stop";
    usernameInput.disabled = false;

    // In individual mode, we are done.
    if (mode === 'individual') {
        alert(`Done! Processed ${processedCount} projects.`);
        return;
    }

    // In batch mode, we check if we have anything to zip
    if (processedCount === 0) {
        alert("No projects were processed.");
        return;
    }

    // Generate Giant Zip
    startBtn.textContent = "Saving ZIP...";
    startBtn.disabled = true;

    try {
        const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
             statSize.textContent = `Zipping: ${metadata.percent.toFixed(1)}%`;
        });
        
        statSize.textContent = formatBytes(content.size);
        
        const a = document.createElement('a');
        a.href = URL.createObjectURL(content);
        a.download = `${usernameInput.value.replace('@','')}_full_backup_${Date.now()}.zip`;
        a.click();
        URL.revokeObjectURL(a.href);

    } catch (e) {
        alert("Error generating ZIP: " + e.message);
    }

    startBtn.textContent = "Start Backup";
    startBtn.disabled = false;
}

startBtn.addEventListener('click', startBackup);
stopBtn.addEventListener('click', () => {
    if (isRunning) {
        stopRequested = true;
        stopBtn.textContent = "Stopping...";
        stopBtn.disabled = true;
    }
});

loadSettings();
checkResumeState();