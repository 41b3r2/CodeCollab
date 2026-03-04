/* =============================================================
   room.js — Firebase-powered collaborative code editor
   All features: real-time sync, cursors, chat, console runner,
   language/theme toggle, sidebar, resize, keyboard shortcuts
============================================================= */

// ── Firebase path refs ────────────────────────────────────────
const ROOM_REF    = `rooms/${APP_ROOM_ID}`;
const CODE_REF    = `${ROOM_REF}/code`;
const LANG_REF    = `${ROOM_REF}/language`;
const CURSORS_REF = `${ROOM_REF}/cursors`;
const USERS_REF   = `${ROOM_REF}/users`;
const CHAT_REF    = `${ROOM_REF}/chat`;
const TYPING_REF  = `${ROOM_REF}/typing`;
const META_REF    = `${ROOM_REF}/meta`;
const PENDING_REF = `${ROOM_REF}/pending`;
const KICKED_REF  = `${ROOM_REF}/kicked`;
const MEMBERS_REF = `${ROOM_REF}/members`;

// ── Language → file extension map ────────────────────────────
const LANG_EXT = {
    javascript: 'js',
    python:     'py',
    c:          'c',
    cpp:        'cpp',
    java:       'java',
    php:        'php',
    ruby:       'rb',
    go:         'go',
    rust:       'rs',
    htmlmixed:  'html',
    css:        'css',
    nodejs:     'js'
};

const LANG_DISPLAY = {
    javascript: 'JavaScript',
    python:     'Python',
    c:          'C',
    cpp:        'C++',
    java:       'Java',
    php:        'PHP',
    ruby:       'Ruby',
    go:         'Go',
    rust:       'Rust',
    htmlmixed:  'HTML',
    css:        'CSS',
    nodejs:     'Node.js'
};

// Wandbox compiler IDs are defined in room.js near runCode()

// CodeMirror modes
const LANG_CM_MODE = {
    javascript: 'javascript',
    python:     'python',
    c:          'text/x-csrc',
    cpp:        'text/x-c++src',
    java:       'text/x-java',
    php:        'php',
    ruby:       'ruby',
    go:         'text/x-go',
    rust:       'text/x-rustsrc',
    htmlmixed:  'htmlmixed',
    css:        'css'
};

const LANG_STARTERS = {
    javascript: `// JavaScript — CodeCollab\nconsole.log("Hello, World!");\n`,
    python:     `# Python — CodeCollab\nprint("Hello, World!")\n`,
    c:          `// C — CodeCollab\n#include <stdio.h>\n\nint main() {\n    printf("Hello, World!\\n");\n    return 0;\n}\n`,
    cpp:        `// C++ — CodeCollab\n#include <iostream>\nusing namespace std;\n\nint main() {\n    cout << "Hello, World!" << endl;\n    return 0;\n}\n`,
    java:       `// Java — CodeCollab\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}\n`,
    php:        `<?php\n// PHP — CodeCollab\necho "Hello, World!\\n";\n`,
    ruby:       `# Ruby — CodeCollab\nputs "Hello, World!"\n`,
    go:         `// Go — CodeCollab\npackage main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello, World!")\n}\n`,
    rust:       `// Rust — CodeCollab\nfn main() {\n    println!("Hello, World!");\n}\n`,
    htmlmixed:  `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Document</title>\n</head>\n<body>\n  <h1>Hello, World!</h1>\n</body>\n</html>\n`,
    css:        `/* CSS — CodeCollab */\nbody {\n  margin: 0;\n  font-family: sans-serif;\n  background: #1e1e2e;\n  color: #cdd6f4;\n}\n`
};

// ── State ─────────────────────────────────────────────────────
let isApplyingRemote = false;
let currentLanguage  = 'javascript';
let stdinQueue       = [];   // pre-queued stdin lines (queued before Run)
let stdinCapture     = null; // active interactive session { lang, code, needed, prompts, collected }
let _capturedPrompts = [];   // prompt strings shown during interaction (used to strip from Wandbox stdout)
let isDarkTheme      = true;
let sidebarOpen      = true;
let consoleOpen      = true;
let activeConsoleTab = 'output';
let errorCount       = 0;
let isRunning        = false;
let typingTimer      = null;
let isTyping         = false;
let remoteCursors    = {};   // userId → { bookmark, label }
let typingUsers      = {};   // userId → timeout

// ── CodeMirror init ───────────────────────────────────────────
const editor = CodeMirror.fromTextArea(document.getElementById('codeEditor'), {
    mode:              'javascript',
    theme:             'dracula',
    lineNumbers:       true,
    autoCloseBrackets: true,
    matchBrackets:     true,
    styleActiveLine:   true,
    indentUnit:        2,
    tabSize:           2,
    indentWithTabs:    false,
    lineWrapping:      false,
    scrollbarStyle:    'simple',
    extraKeys: {
        'Tab':        cm => cm.execCommand('indentMore'),
        'Shift-Tab':  cm => cm.execCommand('indentLess'),
        'Ctrl-/':     cm => cm.execCommand('toggleComment'),
        'Cmd-/':      cm => cm.execCommand('toggleComment'),
        'Ctrl-Enter': ()  => runCode(),
        'Cmd-Enter':  ()  => runCode()
    }
});

isApplyingRemote = true;
editor.setValue(LANG_STARTERS.javascript);
isApplyingRemote = false;
editor.focus();

// ── Cursor info ───────────────────────────────────────────────
editor.on('cursorActivity', () => {
    const pos  = editor.getCursor();
    document.getElementById('cursorInfo').textContent =
        `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
    pushCursor(pos);
});

// ── Live code sync ────────────────────────────────────────────
let codePushTimer = null;
editor.on('change', (cm, change) => {
    if (isApplyingRemote) return;
    clearTimeout(codePushTimer);
    codePushTimer = setTimeout(() => {
        db.ref(CODE_REF).set(cm.getValue());
    }, 250);
    handleTyping();
});

// ── Firebase: code ────────────────────────────────────────────
db.ref(CODE_REF).on('value', snap => {
    clearTimeout(codePushTimer);          // cancel any pending local push
    const remoteCode = snap.val();
    if (remoteCode === null || remoteCode === editor.getValue()) return;
    isApplyingRemote = true;
    const cursor     = editor.getCursor();
    const scrollTop  = editor.getScrollInfo().top;
    editor.setValue(remoteCode);
    const lineCount  = editor.lineCount();
    editor.setCursor({ line: Math.min(cursor.line, lineCount - 1), ch: cursor.ch });
    editor.scrollTo(null, scrollTop);
    isApplyingRemote = false;
});

// ── Firebase: language ────────────────────────────────────────
db.ref(LANG_REF).on('value', snap => {
    const lang = snap.val();
    if (!lang || lang === currentLanguage) return;
    applyLanguage(lang, false);
    document.getElementById('langSelect').value = lang;
});

// ── Firebase: presence ────────────────────────────────────────
const userRef = db.ref(`${USERS_REF}/${APP_USER_ID}`);

function joinRoom() {
    userRef.set({
        username:   APP_USERNAME,
        color:      APP_COLOR,
        joinedAt:   firebase.database.ServerValue.TIMESTAMP,
        online:     true,
        isCreator:  APP_IS_CREATOR
    });
    userRef.onDisconnect().remove();

    // Persist to members list (for room history cascade on deletion)
    db.ref(`${MEMBERS_REF}/${APP_USER_ID}`).set({
        username:  APP_USERNAME,
        color:     APP_COLOR,
        joinedAt:  firebase.database.ServerValue.TIMESTAMP
    });

    // Save room to this user's history
    db.ref(`users/${APP_USER_ID}/rooms/${APP_ROOM_ID}`).set({
        roomId:    APP_ROOM_ID,
        joinedAt:  firebase.database.ServerValue.TIMESTAMP,
        lastVisited: firebase.database.ServerValue.TIMESTAMP,
        isCreator: APP_IS_CREATOR
    });

    // Listen for room deletion (shows overlay + auto-redirects all online members)
    db.ref(META_REF + '/deleted').on('value', snap => {
        if (snap.val() === true && !APP_IS_CREATOR) {
            document.getElementById('roomDeletedOverlay').style.display = 'flex';
            let secs = 3;
            const cdEl = document.getElementById('deleteCountdown');
            const iv = setInterval(() => {
                secs--;
                if (cdEl) cdEl.textContent = secs;
                if (secs <= 0) { clearInterval(iv); window.location.href = 'index.html'; }
            }, 1000);
        }
    });

    // Listen for being kicked out
    db.ref(`${KICKED_REF}/${APP_USER_ID}`).on('value', snap => {
        if (snap.val()) {
            // Mark the room as kicked in the user's own history (they can write their own data)
            db.ref(`users/${APP_USER_ID}/rooms/${APP_ROOM_ID}`)
                .update({ kicked: true }).catch(() => {});

            document.getElementById('kickedOverlay').style.display = 'flex';
            let secs = 3;
            const cdEl = document.getElementById('kickCountdown');
            const iv = setInterval(() => {
                secs--;
                if (cdEl) cdEl.textContent = secs;
                if (secs <= 0) { clearInterval(iv); window.location.href = 'index.html'; }
            }, 1000);
        }
    });
}

if (APP_IS_CREATOR) {
    // Creator: write room meta and join immediately
    db.ref(META_REF).set({ creatorId: APP_USER_ID, creatorUid: APP_USER_ID });
    joinRoom();

    // Listen for incoming join requests
    db.ref(PENDING_REF).on('child_added', snap => {
        if (snap.val() && snap.val().status === 'waiting') showApprovalRequest(snap.key, snap.val());
    });
    db.ref(PENDING_REF).on('child_changed', snap => {
        if (!snap.val() || snap.val().status !== 'waiting') removeApprovalRequest(snap.key);
    });
    db.ref(PENDING_REF).on('child_removed', snap => removeApprovalRequest(snap.key));

} else {
    // Non-creator: check if already a past member → skip approval
    db.ref(`${MEMBERS_REF}/${APP_USER_ID}`).once('value').then(snap => {
        if (snap.exists()) {
            // Returning member — join directly, no approval needed
            joinRoom();
        } else {
            // First-time visitor — go through approval flow
            document.getElementById('waitingOverlay').style.display = 'flex';
            const pendingRef = db.ref(`${PENDING_REF}/${APP_USER_ID}`);
            pendingRef.set({
                username:    APP_USERNAME,
                color:       APP_COLOR,
                requestedAt: firebase.database.ServerValue.TIMESTAMP,
                status:      'waiting'
            });
            pendingRef.onDisconnect().remove();

            pendingRef.on('value', snap => {
                const data = snap.val();
                if (!data) return;
                if (data.status === 'approved') {
                    pendingRef.off();
                    pendingRef.remove();
                    document.getElementById('waitingOverlay').style.display = 'none';
                    joinRoom();
                } else if (data.status === 'denied') {
                    pendingRef.off();
                    pendingRef.remove();
                    document.getElementById('waitingSpinner').style.display = 'none';
                    document.getElementById('waitingTitle').textContent = 'Request Denied';
                    document.getElementById('waitingMsg').textContent = 'The room creator has denied your join request.';
                    setTimeout(() => { window.location.href = 'index.html'; }, 2500);
                }
            });
        }
    }).catch(() => {
        // If check fails, fall through to approval to be safe
        document.getElementById('waitingOverlay').style.display = 'flex';
        const pendingRef = db.ref(`${PENDING_REF}/${APP_USER_ID}`);
        pendingRef.set({
            username:    APP_USERNAME,
            color:       APP_COLOR,
            requestedAt: firebase.database.ServerValue.TIMESTAMP,
            status:      'waiting'
        });
        pendingRef.onDisconnect().remove();
        pendingRef.on('value', snap => {
            const data = snap.val();
            if (!data) return;
            if (data.status === 'approved') {
                pendingRef.off(); pendingRef.remove();
                document.getElementById('waitingOverlay').style.display = 'none';
                joinRoom();
            } else if (data.status === 'denied') {
                pendingRef.off(); pendingRef.remove();
                document.getElementById('waitingSpinner').style.display = 'none';
                document.getElementById('waitingTitle').textContent = 'Request Denied';
                document.getElementById('waitingMsg').textContent = 'The room creator has denied your join request.';
                setTimeout(() => { window.location.href = 'index.html'; }, 2500);
            }
        });
    });
}

db.ref(USERS_REF).on('value', snap => {
    const users = snap.val() || {};
    renderUserList(users);
    renderActiveAvatars(users);
    updateConnectionStatus(true);
});

// ── Firebase: cursors ─────────────────────────────────────────
const myCursorRef = db.ref(`${CURSORS_REF}/${APP_USER_ID}`);
myCursorRef.onDisconnect().remove();

function pushCursor(pos) {
    myCursorRef.set({ line: pos.line, ch: pos.ch, username: APP_USERNAME, color: APP_COLOR });
}

db.ref(CURSORS_REF).on('child_added',   snap => applyCursor(snap));
db.ref(CURSORS_REF).on('child_changed', snap => applyCursor(snap));
db.ref(CURSORS_REF).on('child_removed', snap => removeCursor(snap.key));

function applyCursor(snap) {
    const uid  = snap.key;
    const data = snap.val();
    if (!data || uid === APP_USER_ID) return;
    removeCursor(uid);
    const pos = { line: data.line, ch: data.ch };
    if (pos.line >= editor.lineCount()) return;

    const wrap = document.createElement('span');
    wrap.className = 'remote-cursor';
    wrap.style.borderColor = data.color;

    const lbl = document.createElement('span');
    lbl.className = 'remote-cursor-label';
    lbl.textContent = data.username;
    lbl.style.background = data.color;
    wrap.appendChild(lbl);

    const bookmark = editor.setBookmark(pos, { widget: wrap, insertLeft: true });
    remoteCursors[uid] = { bookmark, label: wrap };
}

function removeCursor(uid) {
    if (remoteCursors[uid]) {
        remoteCursors[uid].bookmark.clear();
        delete remoteCursors[uid];
    }
}

// ── Firebase: typing ─────────────────────────────────────────
function handleTyping() {
    if (!isTyping) {
        isTyping = true;
        db.ref(`${TYPING_REF}/${APP_USER_ID}`).set({ username: APP_USERNAME, color: APP_COLOR });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
        isTyping = false;
        db.ref(`${TYPING_REF}/${APP_USER_ID}`).remove();
    }, 2000);
}

db.ref(TYPING_REF).on('value', snap => {
    const data = snap.val() || {};
    const others = Object.entries(data).filter(([uid]) => uid !== APP_USER_ID);
    const indicator = document.getElementById('typingIndicator');
    if (others.length > 0) {
        const names = others.map(([, v]) => v.username).join(', ');
        // lastChild is the text node after .typing-dots
        const textNode = indicator.lastChild;
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            textNode.textContent = ` ${names} ${others.length === 1 ? 'is' : 'are'} typing...`;
        }
        indicator.style.display = 'flex';
    } else {
        indicator.style.display = 'none';
    }
});

// ── Firebase: chat ────────────────────────────────────────────
db.ref(CHAT_REF).limitToLast(100).on('child_added', snap => {
    const msg = snap.val();
    if (!msg) return;
    renderChatMsg(msg);
});

function sendChat() {
    const input = document.getElementById('chatInput');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    db.ref(CHAT_REF).push({
        uid:      APP_USER_ID,
        username: APP_USERNAME,
        color:    APP_COLOR,
        text,
        ts:       firebase.database.ServerValue.TIMESTAMP
    }).catch(err => {
        console.error('[Chat] Firebase write failed:', err.message);
        showToast('Chat failed: ' + err.message);
        input.value = text;   // restore so user can retry
    });
}

document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat();
});

function renderChatMsg(msg) {
    const box    = document.getElementById('chatBox');
    const isMine = msg.uid === APP_USER_ID;
    const div    = document.createElement('div');
    div.className = `chat-msg ${isMine ? 'own' : ''}`;
    div.style.borderLeftColor = msg.color;
    div.innerHTML = `
        <span class="chat-author" style="color:${escHtml(msg.color)}">
            ${escHtml(msg.username)}
            <small style="font-weight:400;opacity:.6;margin-left:4px">${formatTime(msg.ts)}</small>
        </span>
        ${escHtml(msg.text)}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

// ── Firebase: connection state ────────────────────────────────
db.ref('.info/connected').on('value', snap => {
    updateConnectionStatus(snap.val() === true);
});

function updateConnectionStatus(connected) {
    const el  = document.getElementById('connectionStatus');
    const dot = el.querySelector('.status-dot');
    const txt = el.querySelector('.status-text');
    if (connected) {
        dot.className = 'status-dot connected';
        txt.textContent = 'Connected';
    } else {
        dot.className = 'status-dot disconnected';
        txt.textContent = 'Reconnecting...';
    }
}

// ── Language switch ───────────────────────────────────────────
function changeLanguage(lang) {
    applyLanguage(lang, true);
    db.ref(LANG_REF).set(lang);
}

function applyLanguage(lang, setStarter) {
    currentLanguage = lang;
    editor.setOption('mode', LANG_CM_MODE[lang] || lang);
    editor.refresh();   // force re-highlight after mode switch
    document.getElementById('fileTabName').textContent = `main.${LANG_EXT[lang] || lang}`;
    if (setStarter && !editor.getValue().trim()) {
        isApplyingRemote = true;
        editor.setValue(LANG_STARTERS[lang] || '');
        isApplyingRemote = false;
    }
    // Show terminal input row only for server-side executable languages
    const row = document.getElementById('termInputRow');
    if (row) {
        const show = lang !== 'javascript' && lang !== 'htmlmixed' && lang !== 'css';
        row.style.display = show ? '' : 'none';
        if (show) {
            // Update placeholder to hint the language
            const field = document.getElementById('termInput');
            if (field) field.placeholder = `Type input for ${LANG_DISPLAY[lang]}, press Enter to queue...`;
        }
    }
}

// ── Theme toggle ──────────────────────────────────────────────
function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    document.body.classList.toggle('light-theme', !isDarkTheme);
    editor.setOption('theme', isDarkTheme ? 'dracula' : 'default');
    const icon = document.querySelector('#themeBtn i');
    icon.className = isDarkTheme ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    showToast(isDarkTheme ? '🌙 Dark theme' : '☀️ Light theme');
}

// ── Sidebar toggle ────────────────────────────────────────────
function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    document.getElementById('sidebar').classList.toggle('collapsed', !sidebarOpen);
}

// ── Console toggle ────────────────────────────────────────────
function toggleConsole() {
    consoleOpen = !consoleOpen;
    const panel = document.getElementById('consolePanel');
    const icon  = document.querySelector('#consoleToggleBtn i');
    panel.classList.toggle('collapsed', !consoleOpen);
    // right-pane: chevron-right = visible (collapse rightward), chevron-left = hidden (expand back)
    icon.className = consoleOpen ? 'fa-solid fa-chevron-right' : 'fa-solid fa-chevron-left';
    setTimeout(() => editor.refresh(), 210);
}

// ── Console tabs ──────────────────────────────────────────────
function switchConsoleTab(tab) {
    activeConsoleTab = tab;
    document.getElementById('tabOutput').classList.toggle('active', tab === 'output');
    document.getElementById('tabErrors').classList.toggle('active', tab === 'errors');
}

function clearConsole() {
    const out = document.getElementById('consoleOutput');
    out.innerHTML = '<div class="console-welcome"><i class="fa-solid fa-terminal"></i> &nbsp; Console cleared.</div>';
    errorCount = 0;
    updateErrorBadge();
    clearStdinQueue();
}

function handleTermInput(e) {
    if (e.key !== 'Enter') return;
    const field = document.getElementById('termInput');
    const val   = field.value;
    if (!val) return;
    field.value = '';

    if (stdinCapture) {
        // ── Programiz-style: append typed value to the active prompt line ──
        const cap = stdinCapture;
        cap.collected.push(val);

        // Append typed value onto the same console line as the prompt
        const promptEl = document.getElementById('activePromptLine');
        if (promptEl) {
            promptEl.removeAttribute('id');
            promptEl.textContent += val;  // “Enter first number: 5” on one line
        } else {
            appendLog(`<div class="log-line log">${escHtml(val)}</div>`);
        }

        if (cap.collected.length >= cap.needed) {
            finishInteractiveRun();
        } else {
            showNextInteractivePrompt();
        }
    } else {
        // ── manual pre-queue mode ─────────────────────────────
        stdinQueue.push(val);
        appendLog(`<div class="log-line stdin-echo"><span style="color:var(--text-muted)">&#x276F;</span> ${escHtml(val)}</div>`);
        updateTermBadge();
    }
}

function clearStdinQueue() {
    // Cancel any active capture and restore Run button
    if (stdinCapture) {
        stdinCapture = null;
        resetRunBtn();
        isRunning = false;
        const row = document.getElementById('termInputRow');
        if (row) row.style.display = '';
    }
    stdinQueue = [];
    updateTermBadge();
    document.querySelectorAll('.log-line.stdin-echo').forEach(el => el.remove());
}

function updateTermBadge() {
    const badge   = document.getElementById('termQueueBadge');
    const clearBtn = document.getElementById('termClearBtn');
    if (!badge) return;
    if (stdinQueue.length === 0) {
        badge.style.display   = 'none';
        clearBtn.style.display = 'none';
    } else {
        badge.textContent     = stdinQueue.length + ' input' + (stdinQueue.length !== 1 ? 's' : '') + ' queued';
        badge.style.display   = '';
        clearBtn.style.display = '';
    }
}

// ── stdin detection & interactive terminal (Programiz-style) ─────────────
const STDIN_PATTERNS = {
    c:      /\bscanf\s*\(|\bfgets\s*\(|\bgets\s*\(|\bgetchar\s*\(/,
    cpp:    /\bcin\s*>>|\bscanf\s*\(|\bgetline\s*\(|\bgets_s\s*\(/,
    python: /\binput\s*\(|\braw_input\s*\(/,
    java:   /\.nextInt\b|\.nextLine\b|\.next\b\s*\(\)|\.nextDouble\b|\.nextFloat\b|\.nextLong\b|new\s+Scanner/,
    php:    /fgets\s*\(\s*STDIN|readline\s*\(/,
    ruby:   /\bgets\b|\breadline\b|\$stdin\b/,
    go:     /fmt\.Scan|bufio\.NewReader|\.ReadString/,
    rust:   /read_line|stdin\s*\(\s*\)/,
    nodejs: /readline\.createInterface|\.question\s*\(|\.on\s*\(\s*['"]line['"]/,
};

function codeNeedsStdin(lang, code) {
    const p = STDIN_PATTERNS[lang];
    return p ? p.test(code) : false;
}

// For each input call, find the last print statement that appears BEFORE it in source order.
// Also handles Python input("prompt") style where the prompt is inside the input() call.
function extractCodePrompts(lang, code) {
    // Patterns that extract the string literal from print calls
    const printPats = {
        c:      /printf\s*\(\s*"((?:[^"\\]|\\.)*?)"\s*(?:,[\s\S]*?)?\)|puts\s*\(\s*"((?:[^"\\]|\\.)*?)"/g,
        cpp:    /(?:printf\s*\(\s*"((?:[^"\\]|\\.)*?)")|(?:puts\s*\(\s*"((?:[^"\\]|\\.)*?)")|(?:\bcout\s*<<\s*"((?:[^"\\]|\\.)*?)")/g,
        python: /print\s*\(\s*["']((?:[^"'\\]|\\.)*?)["']/g,
        java:   /System\.out\.print(?:ln|f)?\s*\(\s*"((?:[^"\\]|\\.)*?)"/g,
        php:    /(?:echo\s+["']((?:[^"'\\]|\\.)*?)["']|printf\s*\(\s*"((?:[^"\\]|\\.)*?)")/g,
        ruby:   /(?:puts?\s+["']((?:[^"'\\]|\\.)*?)["']|print\s+["']((?:[^"'\\]|\\.)*?)["'])/g,
        go:     /fmt\.Print(?:f|ln)?\s*\(\s*"((?:[^"\\]|\\.)*?)"/g,
        rust:   /println?!\s*\(\s*"((?:[^"\\]|\\.)*?)"/g,
    };
    // Python/nodejs: capture prompts embedded inside input()/rl.question() calls
    const inputPromptPats = {
        python: /\binput\s*\(\s*["']((?:[^"'\\]|\\.)*?)["']\s*\)/g,
        nodejs: /\.question\s*\(\s*["']((?:[^"'\\]|\\.)*?)["']/g,
    };
    // Patterns to locate each input call position
    const inputPats = {
        c:      /\bscanf\s*\(|\bfgets\s*\(|\bgets\s*\(|\bgetchar\s*\(/g,
        cpp:    /\bcin\s*>>|\bgetline\s*\(\s*cin\b/g,
        python: /\binput\s*\(|\braw_input\s*\(/g,
        java:   /\.(nextInt|nextLine|next|nextDouble|nextFloat|nextLong|nextByte|nextShort)\s*\(/g,
        php:    /(?:fgets\s*\(\s*STDIN|readline\s*\()/g,
        ruby:   /\bgets\b/g,
        go:     /fmt\.Scan\w*\s*\(/g,
        rust:   /\.read_line\s*\(/g,
        nodejs: /\.question\s*\(/g,
    };

    const pp = printPats[lang];
    const ip = inputPats[lang];
    if (!ip) return [];

    // Collect all print positions + text
    const prints = [];
    if (pp) {
        pp.lastIndex = 0;
        let m;
        while ((m = pp.exec(code)) !== null) {
            const raw = (m[1] || m[2] || m[3] || '').replace(/\\n/g, '').replace(/\\t/g, ' ').trim();
            if (raw && raw.length > 1 && raw.length < 120) {
                prints.push({ pos: m.index, text: raw });
            }
        }
    }

    // Collect all input-call positions.
    // C++: cin >> a >> b >> c — each >> is a separate read; enumerate them all
    // so each one maps to the prompt that preceded the full cin statement.
    const inputPositions = [];
    let m;
    if (lang === 'cpp') {
        // Find each cin >> token; for chained statements reuse the same stmt position
        ip.lastIndex = 0;
        while ((m = ip.exec(code)) !== null) {
            inputPositions.push(m.index);
        }
        // For cin >> a >> b, the inputPats.cpp regex only matches the FIRST >>
        // so we additionally scan within each cin statement for further >> chains
        const cinStmtPat = /\bcin\b([^;\n]*);/g;
        let sm;
        while ((sm = cinStmtPat.exec(code)) !== null) {
            const arrows = (sm[1].match(/>>/g) || []).length;
            // arrows > 1 means a chain — inject (arrows-1) extra positions
            // all pointing at the same cin statement start so they use the same prompt
            for (let k = 1; k < arrows; k++) inputPositions.push(sm.index);
        }
        inputPositions.sort((a, b) => a - b);
    } else {
        ip.lastIndex = 0;
        while ((m = ip.exec(code)) !== null) {
            inputPositions.push(m.index);
        }
    }

    // For each input call, pick the last print that appears before it
    const results = inputPositions.map(inputPos => {
        const before = prints.filter(p => p.pos < inputPos);
        return before.length > 0 ? before[before.length - 1].text : null;
    });

    // Fallback for Python: extract prompt from inside input("...") if no print found before it
    const ipp = inputPromptPats[lang];
    if (ipp) {
        ipp.lastIndex = 0;
        const inlinePrompts = [];
        while ((m = ipp.exec(code)) !== null) {
            const raw = (m[1] || '').replace(/\\n/g, '').replace(/\\t/g, ' ').trim();
            inlinePrompts.push(raw || null);
        }
        // Fill in nulls with inline prompts
        for (let i = 0; i < results.length; i++) {
            if (!results[i] && inlinePrompts[i]) results[i] = inlinePrompts[i];
        }
    }

    // Fallback for C/C++: line-proximity scan — look for cout/printf/puts
    // on the same or up to 3 lines above each cin/scanf call
    if ((lang === 'cpp' || lang === 'c') && results.some(r => !r)) {
        const codeLines = code.split('\n');
        for (let i = 0; i < inputPositions.length; i++) {
            if (results[i]) continue;  // already found
            const lineNum = code.slice(0, inputPositions[i]).split('\n').length - 1;
            for (let j = lineNum; j >= Math.max(0, lineNum - 4); j--) {
                const lm = codeLines[j].match(/(?:cout\s*<<|printf\s*\(|puts\s*\()\s*"((?:[^"\\]|\\.)*?)"/);
                if (lm) {
                    const cleaned = lm[1].replace(/\\n/g, '').replace(/\\t/g, ' ').trim();
                    if (cleaned && cleaned.length > 1) { results[i] = cleaned; break; }
                }
            }
        }
    }

    return results.filter(Boolean);
}

function countInputCalls(lang, code) {
    // C++: cin >> a >> b >> c counts as 3 separate reads (chain)
    // Also count each getline(cin, ...) call
    if (lang === 'cpp') {
        let count = 0;
        const cinPat = /\bcin\b([^;\n]*);/g;
        let cm;
        while ((cm = cinPat.exec(code)) !== null) {
            count += (cm[1].match(/>>/g) || []).length;
        }
        count += (code.match(/\bscanf\s*\(/g) || []).length;
        count += (code.match(/\bgetline\s*\(\s*cin\b/g) || []).length;
        return count;
    }
    const pats = {
        c:      /\bscanf\s*\(/g,
        python: /\binput\s*\(|\braw_input\s*\(/g,
        java:   /\.(nextInt|nextLine|next|nextDouble|nextFloat|nextLong|nextByte|nextShort)\s*\(/g,
        php:    /(?:fgets\s*\(\s*STDIN|readline\s*\()/g,
        ruby:   /\bgets\b/g,
        go:     /fmt\.Scan\w*\s*\(/g,
        rust:   /\.read_line\s*\(/g,
        nodejs: /\.question\s*\(/g,
    };
    const re = pats[lang];
    if (!re) return 0;
    const m = code.match(re);
    return m ? m.length : 0;
}

// ── Interactive run (Programiz-style) ───────────────────────────────────────
function startInteractiveRun(lang, code) {
    const needed  = Math.max(countInputCalls(lang, code), 1);
    const prompts = extractCodePrompts(lang, code);

    if (!consoleOpen) toggleConsole();

    isRunning = true;
    _capturedPrompts = [];
    const btn = document.getElementById('runBtn');
    btn.disabled = true;
    btn.classList.add('running');
    btn.querySelector('i').className      = 'fa-solid fa-keyboard';
    btn.querySelector('span').textContent = 'Input...';

    appendLog(`<div class="log-line divider">▶ Running ${LANG_DISPLAY[lang]} — ${new Date().toLocaleTimeString()}</div>`);

    stdinCapture = { lang, code, needed, prompts, collected: [] };
    showNextInteractivePrompt();
}

function showNextInteractivePrompt() {
    const cap   = stdinCapture;
    const idx   = cap.collected.length;
    const prompt = (cap.prompts[idx] || '').trim();

    // Print the prompt text in the console as an open line (no newline yet)
    // The typed value will be appended to it when the user presses Enter
    const out = document.getElementById('consoleOutput');
    const div = document.createElement('div');
    div.className = 'log-line log';
    div.id = 'activePromptLine';
    div.textContent = prompt ? prompt + ' ' : '';
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;

    // Track for filtering Wandbox output later
    if (prompt) _capturedPrompts.push(prompt);

    const row   = document.getElementById('termInputRow');
    const field = document.getElementById('termInput');
    if (row)   row.style.display = '';
    if (field) {
        field.placeholder = prompt ? 'type value...' : `Input ${idx + 1} of ${cap.needed}...`;
        field.disabled    = false;
        field.focus();
    }
}

function finishInteractiveRun() {
    const cap    = stdinCapture;
    stdinCapture = null;
    stdinQueue   = [...cap.collected];

    const row = document.getElementById('termInputRow');
    if (row) row.style.display = 'none';

    const btn = document.getElementById('runBtn');
    btn.querySelector('i').className      = 'fa-solid fa-spinner fa-spin';
    btn.querySelector('span').textContent = 'Running...';

    dispatchWandboxRun(cap.lang, cap.code);
}

// Strip already-shown prompt strings from Wandbox stdout so only
// the computed result is displayed (avoids duplicate prompt lines).
function stripShownPrompts(stdout, prompts) {
    if (!prompts.length) return stdout;
    let remaining = stdout;
    for (const p of prompts) {
        const idx = remaining.indexOf(p);
        if (idx === -1) continue;
        remaining = remaining.slice(idx + p.length).replace(/^[: \t]*/, '');
    }
    return remaining.trim();
}

// ── Run code ─────────────────────────────────────────────────
// Wandbox API  — free, no auth, CORS-enabled  (wandbox.org)
const WANDBOX_URL = 'https://wandbox.org/api/compile.json';
// Maps our lang key → Wandbox compiler id + optional compile options
const LANG_WANDBOX = {
    python: { compiler: 'cpython-3.12.7',    compiler_option_raw: '' },
    c:      { compiler: 'gcc-head-c',        compiler_option_raw: '-std=c17 -lm -Wall' },
    cpp:    { compiler: 'gcc-head',          compiler_option_raw: '-std=c++20 -Wall' },
    java:   { compiler: 'openjdk-jdk-22+36', compiler_option_raw: '' },
    php:    { compiler: 'php-8.3.12',        compiler_option_raw: '' },
    ruby:   { compiler: 'ruby-3.4.1',        compiler_option_raw: '' },
    go:     { compiler: 'go-1.23.2',         compiler_option_raw: '' },
    rust:   { compiler: 'rust-1.82.0',       compiler_option_raw: '' },
    nodejs: { compiler: 'nodejs-20.17.0',    compiler_option_raw: '' },
};

function resetRunBtn() {
    isRunning = false;
    const btn = document.getElementById('runBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('running');
    btn.querySelector('i').className      = 'fa-solid fa-play';
    btn.querySelector('span').textContent = 'Run';
}

function runCode() {
    if (isRunning) return;
    const lang = currentLanguage;
    const code = editor.getValue().trim();

    // Always open console so output is visible
    if (!consoleOpen) toggleConsole();

    // HTML/CSS: view-only, cannot execute
    if (lang === 'htmlmixed' || lang === 'css') {
        appendLog(`<div class="log-line warn">⚠ ${LANG_DISPLAY[lang]} is view-only and cannot be executed.</div>`);
        return;
    }

    if (!code) {
        appendLog('<div class="log-line warn">⚠ Nothing to run — the editor is empty.</div>');
        return;
    }

    // Detect Node.js-style JavaScript early — before the stdin gate
    const isNodeStyle = lang === 'javascript' &&
        /\brequire\s*\(|\bprocess\.env\b|\bprocess\.argv\b|\b__dirname\b|\b__filename\b|\bmodule\.exports\b|\bexports\./.test(code);
    // Effective execution language (nodejs routes to Wandbox Node.js)
    const execLang = isNodeStyle ? 'nodejs' : lang;

    // stdin gate: if code needs input and nothing is pre-queued, simulate interactive terminal
    if (execLang !== 'javascript' && execLang !== 'htmlmixed' && execLang !== 'css'
            && codeNeedsStdin(execLang, code) && stdinQueue.length === 0) {
        startInteractiveRun(execLang, code);
        return;
    }

    isRunning = true;
    const btn = document.getElementById('runBtn');
    btn.disabled = true;
    btn.classList.add('running');
    btn.querySelector('i').className      = 'fa-solid fa-spinner fa-spin';
    btn.querySelector('span').textContent = 'Running...';

    appendLog(`<div class="log-line divider">▶ Running ${LANG_DISPLAY[lang]} — ${new Date().toLocaleTimeString()}</div>`);

    // ── JavaScript: run in browser OR Node.js depending on code ─
    if (lang === 'javascript') {
        if (isNodeStyle) {
            // Node.js-style — send to Wandbox (stdin already collected above if needed)
            dispatchWandboxRun('nodejs', code);
            return;
        }
        const logs = [], errors = [];
        const proxy = {
            log:   (...a) => logs.push({ type: 'log',   msg: fmtArgs(a) }),
            info:  (...a) => logs.push({ type: 'info',  msg: fmtArgs(a) }),
            warn:  (...a) => logs.push({ type: 'warn',  msg: fmtArgs(a) }),
            error: (...a) => { logs.push({ type: 'error', msg: fmtArgs(a) }); errors.push(fmtArgs(a)); }
        };
        try {
            // eslint-disable-next-line no-new-func
            new Function('console', '"use strict";\n' + code)(proxy);
        } catch (err) {
            logs.push({ type: 'error', msg: `${err.name}: ${err.message}` });
            errors.push(`${err.name}: ${err.message}`);
        }
        logs.forEach(e => appendLog(`<div class="log-line ${e.type}">${escHtml(e.msg)}</div>`));
        if (logs.length === 0) appendLog('<div class="log-line success">✓ Executed with no output.</div>');
        appendLog(`<div class="log-line divider">■ Done — ${logs.length} log(s), ${errors.length} error(s)</div>`);
        errorCount += errors.length;
        updateErrorBadge();
        setTimeout(resetRunBtn, 300);
        return;
    }

    // ── All other languages: Wandbox API ───────────────────────
    dispatchWandboxRun(lang, code);
}

// ── Pre-process code before sending to Wandbox ──────────────
// Wandbox always compiles Java as prog.java, so Java requires the
// top-level class NOT to be public (public class forces filename==classname).
function preprocessCode(lang, code) {
    if (lang === 'java') {
        // Strip `public` modifier from top-level class declarations only
        // (lines that start with optional whitespace then `public class`)
        return code.replace(/^([ \t]*)public(\s+class\b)/gm, '$1$2');
    }
    return code;
}

// ── Wandbox execution ─────────────────────────────────────────
function dispatchWandboxRun(lang, code) {
    const wb = LANG_WANDBOX[lang];
    if (!wb) {
        appendLog(`<div class="log-line warn">⚠ ${LANG_DISPLAY[lang]} execution is not supported yet.</div>`);
        resetRunBtn();
        return;
    }

    // Show connecting feedback
    appendLog('<div class="log-line info" id="execConnecting">⏳ Connecting to execution server...</div>');
    const removeConnMsg = () => { const el = document.getElementById('execConnecting'); if (el) el.remove(); };

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 25000);

    const stdinVal    = stdinQueue.join('\n') + (stdinQueue.length ? '\n' : '');
    const sendCode    = preprocessCode(lang, code);

    fetch(WANDBOX_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
            compiler:            wb.compiler,
            compiler_option_raw: wb.compiler_option_raw,
            code:                sendCode,
            stdin:               stdinVal,
            save:                false
        })
    })
    .then(r => {
        if (!r.ok) throw new Error(`Wandbox responded with HTTP ${r.status}`);
        return r.json();
    })
    .then(result => {
        clearTimeout(abortTimer);
        removeConnMsg();

        // Compile errors (C, C++, Java, Rust, Go)
        const compErr = (result.compiler_error  || '').trimEnd();
        const compOut = (result.compiler_output || '').trimEnd();
        if (compErr) {
            compErr.split('\n').forEach(l => {
                if (l.trim()) { appendLog(`<div class="log-line error">${escHtml(l)}</div>`); errorCount++; }
            });
        }
        if (compOut && !compErr) {
            compOut.split('\n').forEach(l => {
                if (l.trim()) appendLog(`<div class="log-line warn">${escHtml(l)}</div>`);
            });
        }

        // Program stdout — strip already-shown prompts, display only the result
        const stdout = (result.program_output || '').trimEnd();
        const stderr = (result.program_error  || '').trimEnd();

        // If we just finished an interactive session, show only the computed result
        // (prompts were already printed inline as the user typed)
        const resultOut = _capturedPrompts.length
            ? stripShownPrompts(stdout, _capturedPrompts)
            : stdout;
        _capturedPrompts = [];

        if (resultOut) {
            resultOut.split('\n').forEach(l => appendLog(`<div class="log-line log">${escHtml(l)}</div>`));
        }

        // Runtime errors / stderr (only show if NOT a stdin starvation error — that
        // should never happen now that we collect inputs before running)
        if (stderr && !isStdinError(lang, compErr, stderr)) {
            stderr.split('\n').forEach(l => {
                if (l.trim()) { appendLog(`<div class="log-line error">${escHtml(l)}</div>`); errorCount++; }
            });
        }

        if (!resultOut && !stderr && !compErr) {
            appendLog('<div class="log-line success">✓ Executed with no output.</div>');
        }

        const exitCode = result.status !== undefined ? ` — exit code ${result.status}` : '';
        appendLog(`<div class="log-line divider">■ Done${exitCode}</div>`);
        updateErrorBadge();
        clearStdinQueue();
        resetRunBtn();
    })
    .catch(err => {
        clearTimeout(abortTimer);
        removeConnMsg();
        if (err.name === 'AbortError') {
            appendLog('<div class="log-line error">✗ Execution timed out after 25 seconds.</div>');
        } else {
            appendLog(`<div class="log-line error">✗ ${escHtml(err.message)}</div>`);
            appendLog('<div class="log-line info">ℹ Execution is powered by wandbox.org. Check your internet connection.</div>');
        }
        errorCount++;
        updateErrorBadge();
        resetRunBtn();
    });
}

// Detect if the program crashed due to missing / exhausted stdin
function isStdinError(lang, compErr, stderr) {
    const haystack = ((compErr || '') + (stderr || '')).toLowerCase();
    if (!haystack) return false;
    // Java: NoSuchElementException / InputMismatchException from Scanner
    if (/nosuchelementexception|inputmismatchexception|no line found/.test(haystack)) return true;
    // Python: EOFError from input()
    if (/eoferror/.test(haystack)) return true;
    // C / C++: reading past EOF
    if (lang === 'c' || lang === 'cpp') {
        if (/end of file|segmentation fault/.test(haystack)) return false; // too generic
    }
    // Ruby: end of file reached (gets returns nil)
    if (/end of file|eof/.test(haystack) && (lang === 'ruby' || lang === 'go' || lang === 'rust')) return true;
    // Go
    if (lang === 'go' && /unexpected eof|eof/.test(haystack)) return true;
    // Rust
    if (lang === 'rust' && /failed to fill whole buffer|eof/.test(haystack)) return true;
    return false;
}

function fmtArgs(args) {
    return args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, null, 2); } catch { return String(a); }
    }).join(' ');
}

function appendLog(html) {
    const out = document.getElementById('consoleOutput');
    const welcome = out.querySelector('.console-welcome');
    if (welcome) welcome.remove();
    const div = document.createElement('div');
    div.innerHTML = html;
    out.appendChild(div.firstElementChild || div);
    out.scrollTop = out.scrollHeight;
}

function updateErrorBadge() {
    const badge = document.getElementById('errorBadge');
    badge.style.display = errorCount > 0 ? 'inline-flex' : 'none';
    badge.textContent = errorCount;
}

// ── Toolbar actions ──────────────────────────────────────────
function clearEditor() {
    if (!confirm('Clear the editor? This will sync to all collaborators.')) return;
    editor.setValue('');
    db.ref(CODE_REF).set('');
    showToast('Editor cleared');
}

function autoIndent() {
    editor.operation(() => {
        for (let i = 0; i < editor.lineCount(); i++) {
            editor.indentLine(i, 'smart');
        }
    });
    showToast('Code auto-indented');
}

function copyAll() {
    navigator.clipboard.writeText(editor.getValue())
        .then(() => showToast('Code copied to clipboard!'))
        .catch(() => showToast('Copy failed — try manually'));
}

function downloadCode() {
    const lang = currentLanguage;
    const ext  = LANG_EXT[lang] || 'txt';
    const blob = new Blob([editor.getValue()], { type: 'text/plain' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `codecollab_${APP_ROOM_ID.toLowerCase()}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`Downloaded as .${ext}`);
}

function copyRoomCode() {
    navigator.clipboard.writeText(APP_ROOM_ID)
        .then(() => {
            const icon = document.getElementById('copyIcon');
            icon.className = 'fa-solid fa-check';
            showToast(`Room code "${APP_ROOM_ID}" copied!`);
            setTimeout(() => { icon.className = 'fa-regular fa-copy'; }, 2000);
        })
        .catch(() => showToast('Copy failed'));
}

function shareRoom() {
    const url = `${location.origin}${location.pathname.replace(/room\.html.*/, '')}index.html?join=${APP_ROOM_ID}`;
    navigator.clipboard.writeText(url)
        .then(() => showToast('Room link copied to clipboard!'))
        .catch(() => prompt('Share this link:', url));
}

// ── Delete Room (creator only) ────────────────────────────────
function deleteRoom() {
    if (!APP_IS_CREATOR) return;
    if (!confirm('Delete this room?\n\nThis will permanently delete the room for everyone and remove it from all members\u2019 history.')) return;
    const btn = document.getElementById('deleteRoomBtn');
    btn.disabled = true;
    btn.querySelector('i').className = 'fa-solid fa-spinner fa-spin';

    // Step 1: mark deleted so online members see the overlay
    db.ref(META_REF + '/deleted').set(true).then(() => {

        // Step 2: fire-and-forget — clean up each member's history (non-blocking)
        db.ref(MEMBERS_REF).once('value').then(snap => {
            Object.keys(snap.val() || {}).forEach(uid => {
                db.ref(`users/${uid}/rooms/${APP_ROOM_ID}`)
                    .update({ deleted: true })
                    .catch(() => {}); // ignore permission errors on other users' data
            });
        }).catch(() => {});

        // Step 3: wait 1.5 s so members can see overlay, then wipe room + redirect
        setTimeout(() => {
            db.ref(ROOM_REF).remove()
                .then(()  => { window.location.href = 'index.html'; })
                .catch(() => { window.location.href = 'index.html'; }); // redirect even if remove fails
        }, 1500);

    }).catch(err => {
        showToast('Delete failed: ' + err.message);
        btn.disabled = false;
        btn.querySelector('i').className = 'fa-solid fa-trash';
    });
}

// ── Approval requests (creator only) ─────────────────────────────────────────
const pendingRequests = {};

function showApprovalRequest(uid, data) {
    pendingRequests[uid] = data;
    renderApprovalPanel();
}

function removeApprovalRequest(uid) {
    delete pendingRequests[uid];
    renderApprovalPanel();
}

function renderApprovalPanel() {
    const panel   = document.getElementById('approvalPanel');
    const list    = document.getElementById('approvalList');
    const counter = document.getElementById('approvalCount');
    const entries = Object.entries(pendingRequests);
    counter.textContent = entries.length;
    panel.style.display = entries.length > 0 ? 'flex' : 'none';
    list.innerHTML = entries.map(([uid, d]) => {
        const safeUid  = escHtml(uid);
        const safeCol  = escHtml(d.color);
        const safeLtr  = escHtml(d.username.charAt(0).toUpperCase());
        const safeName = escHtml(d.username);
        return `<div class="approval-item" id="apr-${safeUid}">
            <div class="apr-avatar" style="background:${safeCol}">${safeLtr}</div>
            <span class="apr-name">${safeName}</span>
            <button class="apr-btn approve" onclick="approveUser('${safeUid}')">
                <i class="fa-solid fa-check"></i> Approve
            </button>
            <button class="apr-btn deny" onclick="denyUser('${safeUid}')">
                <i class="fa-solid fa-xmark"></i> Deny
            </button>
        </div>`;
    }).join('');
}

function approveUser(uid) {
    db.ref(PENDING_REF + '/' + uid + '/status').set('approved');
    removeApprovalRequest(uid);
    showToast('✓ User approved to join.');
}

function denyUser(uid) {
    db.ref(PENDING_REF + '/' + uid + '/status').set('denied');
    removeApprovalRequest(uid);
    showToast('User request denied.');
}

// ── Kick user (creator only) ──────────────────────────────────────────────────
function kickUser(uid, username) {
    if (!confirm('Kick "' + username + '" from the room?')) return;
    db.ref(USERS_REF    + '/' + uid).remove();
    db.ref(KICKED_REF   + '/' + uid).set(true);
    db.ref(CURSORS_REF  + '/' + uid).remove();
    db.ref(TYPING_REF   + '/' + uid).remove();
    db.ref(MEMBERS_REF  + '/' + uid).remove(); // remove from members so they go through approval if they try to rejoin
    showToast('🚫 ' + username + ' has been kicked.');
}

// ── Render helpers ────────────────────────────────────────────────────────────
function renderUserList(users) {
    const list    = document.getElementById('userList');
    const count   = document.getElementById('userCount');
    const entries = Object.entries(users);
    count.textContent = entries.length;
    list.innerHTML = entries.map(([uid, u]) => {
        const isSelf    = uid === APP_USER_ID;
        const safeCol   = escHtml(u.color);
        const safeLtr   = escHtml(u.username.charAt(0).toUpperCase());
        const safeName  = escHtml(u.username);
        const safeUid   = escHtml(uid);
        const crown     = u.isCreator ? '<span class="u-crown" title="Room Creator"><i class="fa-solid fa-crown"></i></span>' : '';
        const kickBtn   = (APP_IS_CREATOR && !isSelf)
            ? '<button class="kick-btn" onclick="kickUser(\'' + safeUid + '\',\'' + safeName.replace(/'/g, '&#39;') + '\')" title="Kick user"><i class="fa-solid fa-user-minus"></i></button>'
            : '';
        return `<div class="user-item ${isSelf ? 'me' : ''}">
            <div class="u-avatar" style="background:${safeCol}">${safeLtr}</div>
            <span class="u-name">${safeName}</span>
            ${crown}
            <span class="u-status">${isSelf ? 'you' : 'online'}</span>
            ${kickBtn}
        </div>`;
    }).join('');
}

function renderActiveAvatars(users) {
    const wrap = document.getElementById('activeUsers');
    const entries = Object.entries(users);
    wrap.innerHTML = entries.slice(0, 8).map(([uid, u]) => `
        <div class="active-avatar" title="${escHtml(u.username)}"
             style="background:${escHtml(u.color)};border-color:${uid === APP_USER_ID ? '#fff' : u.color}">
            ${escHtml(u.username.charAt(0).toUpperCase())}
        </div>`).join('');
    if (entries.length > 8) {
        wrap.innerHTML += `<div class="active-avatar" style="background:#555">+${entries.length - 8}</div>`;
    }
}

// ── Resize handle (horizontal: drags editor/console width) ───
(function initResize() {
    const handle   = document.getElementById('resizeHandle');
    const edPane   = document.getElementById('editorPane');
    const conPanel = document.getElementById('consolePanel');
    let dragging = false, startX = 0, startEW = 0, startCW = 0;

    handle.addEventListener('mousedown', e => {
        dragging = true;
        startX   = e.clientX;
        startEW  = edPane.getBoundingClientRect().width;
        startCW  = conPanel.getBoundingClientRect().width;
        document.body.style.cursor     = 'ew-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const dx    = e.clientX - startX;
        const newEW = Math.max(200, startEW + dx);
        const newCW = Math.max(200, startCW - dx);
        edPane.style.flex   = `0 0 ${newEW}px`;
        conPanel.style.flex = `0 0 ${newCW}px`;
        editor.refresh();
    });
    document.addEventListener('mouseup', () => {
        if (dragging) {
            dragging = false;
            document.body.style.cursor     = '';
            document.body.style.userSelect = '';
            editor.refresh();
        }
    });
})();

// ── Keyboard shortcuts ────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey) {
        if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleSidebar(); }
        if (e.key === '`')                  { e.preventDefault(); toggleConsole(); }
    }
});

// ── Toast ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Utils ─────────────────────────────────────────────────────
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Initial editor refresh ────────────────────────────────────
setTimeout(() => editor.refresh(), 150);
