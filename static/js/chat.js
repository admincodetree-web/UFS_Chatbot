/* ---------- DOM ELEMENT SELECTORS ---------- */
const tray = document.getElementById('tray');
const trayFull = document.getElementById('tray-full');
const trayUp = document.getElementById('tray-up');
const chatbot = document.getElementById('chatbot');
const btnFull = document.getElementById('btn-full');
const btnMinimize = document.getElementById('btn-minimize');
const attachBtn = document.getElementById('attach-btn');
const micBtn = document.getElementById('mic-btn');
const sendBtn = document.getElementById('send-btn');
const chatMessages = document.getElementById('chatMessages');
const userInput = document.getElementById('user-input');

// Search Elements
const btnSearch = document.getElementById('btn-search');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchCount = document.getElementById('search-count');
const searchUp = document.getElementById('search-up');
const searchDown = document.getElementById('search-down');

// Star Nav Elements
const btnStarNav = document.getElementById('btn-star-nav');
const starNavBar = document.getElementById('star-nav-bar');
const starNavCount = document.getElementById('star-nav-count');
const starNavUp = document.getElementById('star-nav-up');
const starNavDown = document.getElementById('star-nav-down');

// Other Elements
const btnCalendar = document.getElementById('btn-calendar');
const datePicker = document.getElementById('date-picker');
const messageContextMenu = document.getElementById('message-context-menu');
const starMessageBtn = document.getElementById('star-message-btn');
const starBtnText = document.getElementById('star-btn-text');
const deleteMessageBtn = document.getElementById('delete-message-btn');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');

/* ---------- GLOBAL STATE ---------- */
let isFullscreen = false;
let isListening = false;
let recognition = null;
let attachedFile = null;
let attachedFileContent = '';
// History State
let currentPage = 1;
let isLoadingMessages = false;
let lastMessageDateStr = null;
// Search State
let searchMatches = [];
let currentMatchIndex = -1;
// Star Nav State
let starMatches = [];
let currentStarIndex = -1;
let contextMenuMessageId = null;

/* ---------- HELPER FUNCTIONS ---------- */

function disableChatInput(message = "Initializing chat...") {
    userInput.disabled = true;
    sendBtn.disabled = true;
    userInput.placeholder = message;
    sendBtn.style.cursor = 'not-allowed';
    sendBtn.style.opacity = '0.6';
}

function enableChatInput() {
    userInput.disabled = false;
    sendBtn.disabled = false;
    userInput.placeholder = "Ask about your domain data...";
    sendBtn.style.cursor = 'pointer';
    sendBtn.style.opacity = '1';
}

function formatDateLabel(dateObj) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
    
    const diffTime = today - msgDate;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays > 0 && diffDays < 7) {
        return msgDate.toLocaleDateString('en-US', { weekday: 'long' });
    }
    return msgDate.toLocaleDateString('en-GB');
}

/* ---------- BASIC MARKDOWN / TABLE HELPERS ---------- */

function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function applyInlineMarkdown(text) {
    // Escape HTML first
    let result = escapeHtml(text);
    // **bold**
    result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return result;
}

function basicMarkdownToHtml(text) {
    const lines = text.split(/\r?\n/);
    let html = "";
    let inList = false;

    for (let line of lines) {
        const trimmed = line.trim();

        if (trimmed.match(/^[-*]\s+/)) {
            if (!inList) {
                html += "<ul>";
                inList = true;
            }
            const itemText = trimmed.replace(/^[-*]\s+/, "");
            html += `<li>${applyInlineMarkdown(itemText)}</li>`;
        } else {
            if (inList) {
                html += "</ul>";
                inList = false;
            }
            if (trimmed !== "") {
                html += `<p>${applyInlineMarkdown(trimmed)}</p>`;
            }
        }
    }

    if (inList) {
        html += "</ul>";
    }
    return html || applyInlineMarkdown(text);
}

function parseMarkdownTable(text) {
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;

    for (let i = 0; i < lines.length - 1; i++) {
        const currentLine = lines[i].trim();
        const nextLine = lines[i + 1].trim();

        // FIX: Relaxed regex. 
        // 1. Current line must have a pipe '|'
        // 2. Next line (separator) must only contain | : - and whitespace
        // 3. Next line must have at least one dash '-'
        // REMOVED: The strict requirement for nextLine.includes("|"), as some MD tables skip outer pipes.
        if (currentLine.includes("|") && 
            nextLine.match(/^[|:\-\s]+$/) && 
            nextLine.includes("-")) {
            headerIdx = i;
            break;
        }
    }

    if (headerIdx === -1) {
        return null;
    }

    const before = lines.slice(0, headerIdx).join("\n").trim();
    const headerLine = lines[headerIdx];
    // line[headerIdx+1] is separator, skip it
    let rowLines = [];
    for (let i = headerIdx + 2; i < lines.length; i++) {
        // Stop if line is empty string (end of table block)
        if (lines[i].trim() === "") break;
        // If line doesn't have a pipe, it's likely end of table (or broken row)
        if (!lines[i].includes("|")) break;
        rowLines.push(lines[i]);
    }

    function splitRow(line) {
        return line
            .split("|")
            .map(c => c.trim())
            .filter(c => c.length > 0); // Filter empty strings caused by leading/trailing pipes
    }

    const headers = splitRow(headerLine);
    const rows = rowLines.map(splitRow);

    if (!headers.length || !rows.length) {
        return null;
    }

    return {
        intro: before,
        headers,
        rows
    };
}

function exportTableAsCSV(headers, rows) {
    const allRows = [headers, ...rows];
    const csvLines = allRows.map(row =>
        row
            .map(val => {
                const v = (val ?? "").toString();
                const escaped = v.replace(/"/g, '""');
                return `"${escaped}"`;
            })
            .join(",")
    );
    const csvContent = csvLines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chat-table-export.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function renderBotContent(containerEl, rawText) {
    const text = (rawText || "").trim();
    containerEl.innerHTML = "";

    if (!text) {
        return;
    }

    // Try to detect markdown table
    const tableParsed = parseMarkdownTable(text);

    if (tableParsed) {
        const { intro, headers, rows } = tableParsed;

        if (intro) {
            const introDiv = document.createElement("div");
            introDiv.innerHTML = basicMarkdownToHtml(intro);
            containerEl.appendChild(introDiv);
        }

        const wrapper = document.createElement("div");
        wrapper.className = "table-wrapper";

        const table = document.createElement("table");
        table.className = "chat-table";
        const thead = document.createElement("thead");
        const headTr = document.createElement("tr");
        
        headers.forEach((h, idx) => {
            const th = document.createElement("th");
            th.textContent = h;
            
            // If this is the last column header, inject the download button here
            if (idx === headers.length - 1) {
                const exportBtn = document.createElement("button");
                exportBtn.className = "table-export-btn";
                exportBtn.title = "Export to CSV";
                exportBtn.innerHTML = `
                  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 3v12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M8 11l4 4 4-4" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M5 19h14" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>`;
                exportBtn.addEventListener("click", (e) => {
                    e.stopPropagation(); 
                    exportTableAsCSV(headers, rows);
                });
                th.appendChild(exportBtn);
            }
            
            headTr.appendChild(th);
        });
        
        thead.appendChild(headTr);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        rows.forEach(r => {
            const tr = document.createElement("tr");
            headers.forEach((_, idx) => {
                const td = document.createElement("td");
                // Handle case where row has fewer cells than header
                td.textContent = r[idx] ?? "";
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        wrapper.appendChild(table);
        containerEl.appendChild(wrapper);
    } else {
        // No table – just render formatted text
        containerEl.innerHTML = basicMarkdownToHtml(text);
    }
}

/* ---------- WHATSAPP-STYLE HISTORY & MESSAGES ---------- */

async function loadInitialMessages() {
    disableChatInput("Loading messages...");
    chatMessages.innerHTML = '';
    currentPage = 1;
    lastMessageDateStr = null;
    try {
        const messages = await fetchMessages(currentPage);
        if (messages.length > 0) {
            
            // SORTING FIX: Ensure user message comes first if timestamps are identical
            messages.sort((a, b) => {
                const timeA = new Date(a.timestamp).getTime();
                const timeB = new Date(b.timestamp).getTime();
                if (timeA === timeB) {
                    if (a.role === 'user' && b.role === 'bot') return -1;
                    if (a.role === 'bot' && b.role === 'user') return 1;
                }
                return timeA - timeB;
            });

            messages.forEach(msg => appendMessage(msg, 'append'));
            
            // SCROLL FIX: Use scrollIntoView + increased timeout for robust bottom scrolling
            setTimeout(() => {
                if (chatMessages.lastElementChild) {
                    chatMessages.lastElementChild.scrollIntoView({ block: "end" });
                } else {
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                }
            }, 100);
            
        } else {
            chatMessages.innerHTML = '<div style="color:#666;margin-top:6px;text-align:center;">Welcome! Start the conversation.</div>';
        }
        enableChatInput();
    } catch (error) {
        console.error('Error loading initial messages:', error);
        appendBotMessage('Error loading messages.', false, 'error');
        disableChatInput("Error loading messages.");
    }
}

async function loadMoreMessages() {
    if (isLoadingMessages) return;
    isLoadingMessages = true;
    currentPage++;
    
    const oldScrollHeight = chatMessages.scrollHeight;
    const oldScrollTop = chatMessages.scrollTop;

    try {
        const messages = await fetchMessages(currentPage);
        if (messages.length > 0) {
            // Sort new older messages (Standard reverse time order for prepending)
            messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            // We need them in reverse order to prepend correctly (newest of the old batch first)
            messages.reverse().forEach(msg => appendMessage(msg, 'prepend'));
            
            chatMessages.scrollTop = chatMessages.scrollHeight - oldScrollHeight + oldScrollTop;
        } else {
            chatMessages.removeEventListener('scroll', handleScroll);
        }
    } catch (error) {
        console.error('Error loading more messages:', error);
    } finally {
        isLoadingMessages = false;
    }
}

async function fetchMessages(page) {
    // Backend history was removed per user request, return empty list
    return [];
}

function appendMessage(msg, method = 'append') {
    const messageDate = new Date(msg.timestamp);
    const formattedDateLabel = formatDateLabel(messageDate);

    if (lastMessageDateStr !== formattedDateLabel) {
        const separator = document.createElement('div');
        separator.className = 'date-separator';
        separator.textContent = formattedDateLabel;
        separator.dataset.date = messageDate.toISOString().split('T')[0];
        separator.onclick = () => {
            datePicker.value = separator.dataset.date;
            datePicker.showPicker();
        };
        
        if (method === 'append') {
            chatMessages.appendChild(separator);
        } else {
            chatMessages.insertBefore(separator, chatMessages.firstChild);
        }
        lastMessageDateStr = formattedDateLabel;
    }

    const row = document.createElement('div');
    row.className = 'msg-row';

    const el = document.createElement('div');
    el.className = `msg ${msg.role === 'user' ? 'user-msg' : 'bot-msg'}`;
    el.dataset.messageId = msg.id;
    if (msg.is_starred) {
        el.classList.add('starred');
    }

    const starIcon = document.createElement('img');
    starIcon.className = 'star-icon';
    const svgString = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#FFD700" stroke="#000000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
    starIcon.src = 'data:image/svg+xml;base64,' + btoa(svgString);
    
    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';

    const timestamp = document.createElement('span');
    timestamp.className = 'timestamp';
    timestamp.textContent = messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    el.appendChild(starIcon);
    el.appendChild(textSpan);
    el.appendChild(timestamp);
    row.appendChild(el);

    // Render content differently for user vs bot
    if (msg.role === 'user') {
        textSpan.textContent = msg.message;
    } else {
        renderBotContent(textSpan, msg.message);
    }

    if (method === 'append') {
        chatMessages.appendChild(row);
    } else {
        const firstChild = chatMessages.firstChild;
        if (firstChild && firstChild.classList.contains('date-separator')) {
            chatMessages.insertBefore(row, firstChild.nextSibling);
        } else {
            chatMessages.insertBefore(row, firstChild);
        }
    }
}

function handleScroll() {
    if (chatMessages.scrollTop === 0) {
        loadMoreMessages();
    }
    
    // Check for Scroll Button visibility
    const isNearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 100;
    if (isNearBottom) {
        scrollBottomBtn.style.display = 'none';
    } else {
        scrollBottomBtn.style.display = 'flex';
    }
}

/* ---------- SEARCH & STAR NAV HELPERS ---------- */

function closeSearch() {
    searchBar.style.display = 'none';
    searchInput.value = '';
    searchCount.textContent = '0 of 0';
    searchMatches = [];
    currentMatchIndex = -1;
    // Remove highlights logic
    chatMessages.querySelectorAll('mark').forEach(mark => { 
        mark.outerHTML = mark.innerHTML; 
    });
}

function closeStarNav() {
    starNavBar.style.display = 'none';
    document.querySelectorAll('.msg.star-highlight').forEach(el => el.classList.remove('star-highlight'));
}

/* ---------- SEARCH LOGIC ---------- */

function performSearch() {
    const query = searchInput.value;
    chatMessages.querySelectorAll('mark').forEach(mark => { mark.outerHTML = mark.innerHTML; });
    searchMatches = [];
    currentMatchIndex = -1;

    if (query.length < 2) { searchCount.textContent = ''; return; }

    const messageTextElements = chatMessages.querySelectorAll('.msg-text');
    messageTextElements.forEach(el => {
        const text = el.textContent;
        const regex = new RegExp(query, 'gi');
        if (text.match(regex)) {
            el.innerHTML = text.replace(regex, match => `<mark>${match}</mark>`);
        }
    });

    searchMatches = Array.from(chatMessages.querySelectorAll('mark'));
    if (searchMatches.length > 0) {
        currentMatchIndex = searchMatches.length - 1;
        navigateSearch(0);
    } else {
        updateSearchCount();
    }
}

function updateSearchCount() {
    if (searchMatches.length > 0) {
        searchCount.textContent = `${currentMatchIndex + 1} of ${searchMatches.length}`;
        searchMatches.forEach((match, index) => {
            match.classList.toggle('current-match', index === currentMatchIndex);
        });
    } else {
        searchCount.textContent = '0 of 0';
    }
}

function navigateSearch(direction) {
    if (searchMatches.length === 0) return;
    currentMatchIndex += direction;
    if (currentMatchIndex < 0) currentMatchIndex = searchMatches.length - 1;
    if (currentMatchIndex >= searchMatches.length) currentMatchIndex = 0;
    searchMatches[currentMatchIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    updateSearchCount();
}

// Toggle Search
btnSearch.addEventListener('click', () => { 
    closeStarNav(); 
    
    if (searchBar.style.display === 'flex') {
        closeSearch(); 
    } else {
        searchBar.style.display = 'flex';
        searchInput.focus(); 
    }
});

// Toggle Star Nav
btnStarNav.addEventListener('click', toggleStarNav);

function toggleStarNav() {
    if (starNavBar.style.display === 'flex') {
        closeStarNav();
    } else {
        closeSearch(); 
        starNavBar.style.display = 'flex';
        performStarNav();
    }
}

function performStarNav() {
    starMatches = Array.from(document.querySelectorAll('.msg.starred'));
    if (starMatches.length > 0) {
        currentStarIndex = starMatches.length - 1;
        navigateStar(0);
    } else {
        starNavCount.textContent = "0 starred";
    }
}

function navigateStar(direction) {
    if (starMatches.length === 0) return;
    
    if (currentStarIndex >= 0 && starMatches[currentStarIndex]) {
        starMatches[currentStarIndex].classList.remove('star-highlight');
    }

    currentStarIndex += direction;
    if (currentStarIndex < 0) currentStarIndex = starMatches.length - 1;
    if (currentStarIndex >= starMatches.length) currentStarIndex = 0;
    
    const targetMsg = starMatches[currentStarIndex];
    targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    targetMsg.classList.add('star-highlight');
    
    starNavCount.textContent = `${currentStarIndex + 1} of ${starMatches.length}`;
}

searchInput.addEventListener('input', performSearch);
searchUp.addEventListener('click', () => navigateSearch(-1));
searchDown.addEventListener('click', () => navigateSearch(1));

starNavUp.addEventListener('click', () => navigateStar(-1));
starNavDown.addEventListener('click', () => navigateStar(1));

/* ---------- CALENDAR & CONTEXT MENU ---------- */

/* ---------- CALENDAR & CONTEXT MENU ---------- */

/* ---------- CALENDAR & CONTEXT MENU ---------- */

async function jumpToDate(date) {
    // Backend history was removed per user request
    if (date) {
        alert("Chat history feature has been disabled.");
    }
    loadInitialMessages();
}

function showContextMenu(event) {
    event.preventDefault();
    const clickedMsg = event.target.closest('.msg');
    if (!clickedMsg) return;

    contextMenuMessageId = clickedMsg.dataset.messageId;
    
    if (clickedMsg.classList.contains('starred')) {
        starBtnText.textContent = "Unstar message";
    } else {
        starBtnText.textContent = "Star message";
    }

    messageContextMenu.style.top = `${event.clientY}px`;
    messageContextMenu.style.left = `${event.clientX}px`;
    messageContextMenu.style.display = 'block';
}

function hideContextMenu() {
    messageContextMenu.style.display = 'none';
    contextMenuMessageId = null;
}

async function starMessage() {
    const messageId = contextMenuMessageId;
    if (!messageId) return;

    hideContextMenu(); 

    const msgEl = document.querySelector(`.msg[data-message-id="${messageId}"]`);
    if (msgEl) {
        msgEl.classList.toggle('starred');
        if (starNavBar.style.display === 'flex') performStarNav();
    }

    try {
        // Backend history was removed, just fake success
        const res = { ok: true, json: async () => ({}) };

        try {
            const data = await res.json();
            if (msgEl && typeof data.is_starred === 'boolean') {
                if (data.is_starred) {
                    msgEl.classList.add('starred');
                } else {
                    msgEl.classList.remove('starred');
                }
                if (starNavBar.style.display === 'flex') performStarNav();
            }
        } catch (_) {}

    } catch (error) {
        console.error('Error starring message:', error);
        if (msgEl) {
            msgEl.classList.toggle('starred');
            alert("Connection failed. Star action reverted.");
        }
    }
}

async function deleteMessage() {
    const messageId = contextMenuMessageId;
    if (!messageId) return;

    hideContextMenu();

    if (confirm("Are you sure you want to delete this message and its subsequent response?")) {
        try {
            // Backend history was removed, just fake success
            const response = { ok: true, json: async () => ({}) };
            const data = await response.json();
            if (data.deleted_ids) {
                data.deleted_ids.forEach(id => {
                    const msgEl = document.querySelector(`.msg[data-message-id="${id}"]`);
                    if (msgEl) msgEl.parentElement.remove();
                });
            }
        } catch (error) {
            console.error('Error deleting message:', error);
        }
    }
}

/* ---------- ORIGINAL UI AND FEATURE FUNCTIONS ---------- */

/* ---------- Build tray icons (inline svgs) ---------- */
trayFull.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg"><path d="M3 9V3h6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 15v6h-6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 3l-8 8" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 21l8-8" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
trayUp.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><path d="m18 15-6-6-6 6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* ---------- Tray behavior ---------- */
function showTray(){ tray.style.display='flex'; chatbot.style.display='none'; chatbot.classList.remove('fullscreen'); isFullscreen=false; }
function showMinimizedWindow(){ tray.style.display='none'; chatbot.style.display='flex'; chatbot.classList.remove('fullscreen'); isFullscreen=false; chatbot.setAttribute('aria-hidden','false'); }
function showFullScreen(){ tray.style.display='none'; chatbot.style.display='flex'; chatbot.classList.add('fullscreen'); isFullscreen=true; chatbot.setAttribute('aria-hidden','false'); }

/* ---------- Speech to Text ---------- */
function initSpeechRecognition() {
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      isListening = true;
      micBtn.style.background = 'rgba(28, 61, 34, 0.2)';
      micBtn.title = 'Stop listening';
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      userInput.value = transcript;
      userInput.style.height = 'auto';
      userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
    };

    recognition.onend = () => {
      isListening = false;
      micBtn.style.background = '';
      micBtn.title = 'Speech to Text (Dictate)';
    };

    recognition.onerror = () => {
      isListening = false;
      micBtn.style.background = '';
      micBtn.title = 'Speech to Text (Dictate)';
    };
  }
}

/* ---------- File handling ---------- */
function showFilePreview(file) {
  attachedFile = file;
  const fileIcon = getFileIcon(file.name);
  const fileType = getFileExtension(file.name);
  
  document.getElementById('file-icon-text').textContent = fileIcon;
  document.getElementById('file-name-preview').textContent = truncateFileName(file.name, 25);
  document.getElementById('file-type-preview').textContent = fileType;
  document.getElementById('file-preview').style.display = 'block';
}

function hideFilePreview() {
  attachedFile = null;
  attachedFileContent = '';
  document.getElementById('file-preview').style.display = 'none';
}

function getFileIcon(filename) {
  const ext = getFileExtension(filename).toLowerCase();
  const iconMap = {
    'pdf': 'P', 'doc': 'D', 'docx': 'D', 'xls': 'X', 'xlsx': 'X',
    'csv': 'C', 'txt': 'T', 'jpg': 'I', 'jpeg': 'I', 'png': 'I',
    'gif': 'I', 'mp4': 'V', 'avi': 'V', 'mov': 'V', 'mp3': 'A',
    'wav': 'A', 'zip': 'Z', 'rar': 'R'
  };
  return iconMap[ext] || 'F';
}

function getFileExtension(filename) {
  return filename.split('.').pop() || 'FILE';
}

function truncateFileName(filename, maxLength) {
  if (filename.length <= maxLength) return filename;
  const ext = getFileExtension(filename);
  const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
  const truncatedName = nameWithoutExt.substring(0, maxLength - ext.length - 4) + '...';
  return truncatedName + '.' + ext;
}

/* ---------- API calls ---------- */
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message && !attachedFile) return;

    const tempId = 'temp-' + Date.now();
    
    appendMessage({ 
        role: 'user', 
        message: message, 
        timestamp: new Date().toISOString(), 
        id: tempId 
    }, 'append');
    
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });

    userInput.value = '';
    userInput.style.height = '40px';
    hideFilePreview();

    const loadingRow = appendBotMessage('', true);

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: message,
                file_content: attachedFileContent,
            })
        });

        const data = await response.json();
        loadingRow.remove();

        if (data.error) {
            appendBotMessage(`Error: ${data.error}`, false, 'error');
        } else {
            const tempMsgEl = document.querySelector(`.msg[data-message-id="${tempId}"]`);
            if (tempMsgEl && data.user_message_id) {
                tempMsgEl.dataset.messageId = data.user_message_id;
            }

            appendMessage({ 
                role: 'bot', 
                message: data.response, 
                timestamp: new Date().toISOString(), 
                id: data.bot_message_id || ('bot-' + Date.now())
            }, 'append');
            
            chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
        }
    } catch (error) {
        loadingRow.remove();
        appendBotMessage(`Network error: ${error.message}`, false, 'error');
    }
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    
    if (data.error) {
      alert(`Upload error: ${data.error}`);
    } else {
      attachedFileContent = data.content;
      showFilePreview(file);
    }
    
  } catch (error) {
    alert(`Upload error: ${error.message}`);
  }
}

/* ---------- Message handling (thinking + error) ---------- */
function appendBotMessage(text, isLoading = false, type = 'success') {
    const row = document.createElement('div');
    row.className = 'msg-row';
    
    if (isLoading) {
        const loadingInner = document.createElement('div');
        loadingInner.className = 'thinking-indicator';
        loadingInner.innerHTML = 'Bot is thinking <span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';
        row.appendChild(loadingInner);
        chatMessages.appendChild(row);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return row;
    }
    
    const el = document.createElement('div');
    el.className = 'msg bot-msg';
    el.textContent = text;
    if (type === 'warning') {
        el.style.background = '#ff6b35';
    } else if (type === 'error') {
        el.style.background = '#e74c3c';
    }
    row.appendChild(el);
    
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return row;
}

/* ---------- EVENT LISTENERS ---------- */
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

attachBtn.addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.pdf,.doc,.docx,.xls,.xlsx,.csv,image/*';
  inp.onchange = (ev) => {
    const file = ev.target.files[0];
    if (file) uploadFile(file);
  };
  inp.click();
});

document.getElementById('remove-file-btn').addEventListener('click', hideFilePreview);

trayFull.addEventListener('click', (e)=>{ showFullScreen(); });
trayUp.addEventListener('click', (e)=>{ showMinimizedWindow(); });

btnFull.addEventListener('click', (e)=>{
  if (!isFullscreen) showFullScreen();
  else { showMinimizedWindow(); }
});
btnMinimize.addEventListener('click', (e)=>{ showTray(); });

micBtn.addEventListener('click', ()=>{
  if (!recognition) {
    initSpeechRecognition();
    if (!recognition) {
      alert("Speech recognition not supported");
      return;
    }
  }
  if (isListening) {
    recognition.stop();
  } else {
    recognition.start();
  }
});

chatMessages.addEventListener('scroll', handleScroll);
scrollBottomBtn.addEventListener('click', () => {
    chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: 'smooth' });
});

btnCalendar.addEventListener('click', () => datePicker.showPicker());
datePicker.addEventListener('change', (e) => jumpToDate(e.target.value));

chatMessages.addEventListener('contextmenu', showContextMenu);
document.addEventListener('click', hideContextMenu);
starMessageBtn.addEventListener('click', starMessage);
deleteMessageBtn.addEventListener('click', deleteMessage);

/* ---------- INITIALIZATION ---------- */
showTray();
loadInitialMessages();

/* ---------- MOUSE TRACKING FOR TOOLTIPS ---------- */
document.addEventListener('mousemove', (e) => {
  document.documentElement.style.setProperty('--mouse-x', e.clientX + 'px');
  document.documentElement.style.setProperty('--mouse-y', e.clientY + 'px');
});