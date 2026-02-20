// ==========================================
// 1. CONFIGURATION – REPLACE WITH YOUR RAILWAY URL
// ==========================================
const SERVER_URL = "https://inposter-backend-production.up.railway.app";   // ⚠️ CHANGE THIS
const socket = io(SERVER_URL);

// --- STATE ---
let me = {
    name: '',
    room: '',
    id: null,
    isHost: false,
    role: ''
};
let currentPhase = '';
let playersCache = {};
let selectedVoteIds = [];
let revealTimer = null;

// --- DOM HELPERS ---
const el = (id) => document.getElementById(id);

window.nav = (screenId) => {
    document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
    el(screenId).classList.remove('hidden');
    const chat = el('chat-area');
    if (['screen-lobby', 'screen-reveal', 'screen-game', 'screen-vote', 'screen-result'].includes(screenId)) {
        chat.classList.remove('hidden');
    } else {
        chat.classList.add('hidden');
    }
};

window.hold = (isHeld) => {
    const card = document.querySelector('.card-scene');
    if (card) card.classList.toggle('held', isHeld);
};

// ==========================================
// 2. SOCKET EVENT LISTENERS
// ==========================================
socket.on('connect', () => {
    console.log('Connected, ID:', socket.id);
    me.id = socket.id;
    const stored = loadMeFromStorage();
    if (stored && stored.name && stored.room) {
        showRejoinPrompt(stored);
    } else {
        nav('screen-start');
    }
});

socket.on('gameState', (roomData) => {
    playersCache = roomData.players || {};
    me.isHost = (roomData.hostId === socket.id);
    if (roomData.id) me.room = roomData.id;

    if (roomData.phase !== currentPhase) {
        handlePhaseChange(roomData.phase, roomData);
    }

    if (roomData.phase === 'LOBBY') updateLobby(Object.values(playersCache), roomData);
    else if (roomData.phase === 'GAME') updateGame(roomData);
    else if (roomData.phase === 'PRE_VOTE') updatePreVote(Object.values(playersCache));
    else if (roomData.phase === 'VOTE') renderVoteButtons(Object.values(playersCache), roomData.settings.imposters);
    else if (roomData.phase === 'RESULT') updateResult(roomData);

    currentPhase = roomData.phase;
    updateChatTargets(); // refresh player list in chat dropdown
});

socket.on('revealSecret', ({ role, word }) => {
    el('secret-word').innerText = word;
    me.role = role;
    startRevealTimer();
});

socket.on('gameResult', (roomData) => {
    updateResult(roomData);
    nav('screen-result');
});

socket.on('error', (msg) => alert(msg));

socket.on('chatMessage', ({ sender, msg, target }) => {
    addChatMessage(sender, msg, target);
});

// ==========================================
// 3. ACTIONS (emitted to server)
// ==========================================
window.createRoom = () => {
    const name = el('c-name').value.trim();
    if (!name) return alert("Enter your name!");
    me.name = name;
    socket.emit('createRoom', {
        name,
        imposters: parseInt(el('c-imp').value),
        cycles: parseInt(el('c-cyc').value)
    });
    saveMeToStorage();
};

window.joinRoom = () => {
    const name = el('j-name').value.trim();
    const roomId = el('j-room').value.trim();
    if (!name || !roomId) return alert("Fill all fields!");
    me.name = name;
    me.room = roomId;
    socket.emit('joinRoom', { name, roomId });
    saveMeToStorage();
};

window.toggleReady = () => {
    socket.emit('toggleReady', me.room);
    el('btn-ready').disabled = true;
    el('btn-ready').innerText = "WAITING...";
};

window.submitWord = () => {
    const txt = el('game-input').value.trim();
    if (!txt) return;
    socket.emit('submitWord', { roomId: me.room, word: txt });
    el('game-input').value = '';
};

window.goToVote = () => {
    el('btn-goto-vote').disabled = true;
    el('btn-goto-vote').innerText = "Waiting for others...";
    socket.emit('readyForVote', me.room);
};

window.confirmVote = () => {
    const votesObj = {};
    selectedVoteIds.forEach(id => { votesObj[id] = true; });
    socket.emit('submitVote', { roomId: me.room, votesObj });
    el('btn-vote-confirm').disabled = true;
};

window.playAgain = () => {
    clearMeFromStorage();
    nav('screen-start');
};

window.sendChat = () => {
    const msg = el('chat-txt').value.trim();
    const target = el('chat-target').value;
    if (!msg) return;
    socket.emit('sendChat', { roomId: me.room, msg, target });
    el('chat-txt').value = '';
};

// ==========================================
// 4. UI UPDATE FUNCTIONS
// ==========================================
function handlePhaseChange(newPhase, data) {
    if (newPhase === 'LOBBY') {
        nav('screen-lobby');
        el('lobby-code').innerText = data.id;
    } else if (newPhase === 'REVEAL') {
        nav('screen-reveal');
    } else if (newPhase === 'GAME') {
        nav('screen-game');
        el('game-over-section').classList.add('hidden');
        el('latest-word-text').innerText = "---";
        el('latest-player-name').innerText = "Game Started";
    } else if (newPhase === 'PRE_VOTE') {
        nav('screen-game');
        el('game-over-section').classList.remove('hidden');
        el('game-input').disabled = true;
        el('btn-submit').disabled = true;
    } else if (newPhase === 'VOTE') {
        nav('screen-vote');
        selectedVoteIds = [];
        el('btn-vote-confirm').disabled = true;
    } else if (newPhase === 'RESULT') {
        nav('screen-result');
    }
}

function updateLobby(pList, data) {
    const listHtml = pList.map(p => `
        <div class="player-row">
            <span>${p.name} ${data.hostId === p.id ? '👑' : ''}</span>
            <span class="${p.isReady ? 'ready-yes' : 'ready-no'}">
                ${p.isReady ? '[READY]' : '[WAIT]'}
            </span>
        </div>
    `).join('');
    el('lobby-list').innerHTML = listHtml;

    // Auto-start if host and all ready (min 2 players)
    if (me.isHost && pList.length >= 2 && pList.every(p => p.isReady)) {
        socket.emit('startGame', me.room);
    }
}

function updateGame(data) {
    el('game-cycle').innerText = data.currentCycle;

    const hist = data.history || [];
    if (hist.length > 0) {
        const last = hist[hist.length - 1];
        el('latest-word-text').innerText = last.word;
        el('latest-player-name').innerText = `Typed by: ${last.player}`;
    }
    el('game-history').innerHTML = hist.map(h =>
        `<div class="hist-item"><b>${h.player}:</b> ${h.word}</div>`
    ).join('');

    const turnOrder = data.turnOrder || [];
    const currentPlayerId = turnOrder[data.turnIndex];
    const isMyTurn = currentPlayerId === socket.id;

    const turnTxt = el('game-turn-txt');
    const input = el('game-input');
    const btn = el('btn-submit');

    if (isMyTurn) {
        turnTxt.innerText = "YOUR TURN!";
        turnTxt.style.color = "var(--grass-green)";
        input.disabled = false;
        btn.disabled = false;
    } else {
        const pName = currentPlayerId ? (playersCache[currentPlayerId]?.name || '...') : '...';
        turnTxt.innerText = `Waiting for ${pName}...`;
        turnTxt.style.color = "var(--brick-red)";
        input.disabled = true;
        btn.disabled = true;
    }
}

function updatePreVote(pList) {
    const readyCount = pList.filter(p => p.wantsVote).length;
    el('vote-wait-status').innerText = `${readyCount}/${pList.length} Players Ready`;
    if (me.isHost && pList.every(p => p.wantsVote)) {
        socket.emit('forceVotePhase', me.room);
    }
}

function renderVoteButtons(pList, imposterCount) {
    const grid = el('vote-area');
    grid.innerHTML = '';

    const myData = playersCache[socket.id];
    const hasVoted = myData && myData.votes && Object.keys(myData.votes).length > 0;

    pList.forEach(p => {
        if (p.id === socket.id) return;
        const div = document.createElement('div');
        div.className = 'vote-block';
        div.innerText = p.name;
        div.dataset.id = p.id;

        if (hasVoted) {
            div.classList.add('disabled');
            if (myData.votes[p.id]) div.classList.add('selected');
        } else {
            div.onclick = (e) => toggleVoteSelection(e, imposterCount);
        }
        grid.appendChild(div);
    });

    let instruction = document.querySelector('#vote-area + p');
    if (!instruction) {
        instruction = document.createElement('p');
        grid.insertAdjacentElement('afterend', instruction);
    }
    instruction.innerText = `Select ${imposterCount} player(s) you suspect.`;

    el('btn-vote-confirm').disabled = hasVoted || selectedVoteIds.length !== imposterCount;
}

function toggleVoteSelection(evt, imposterCount) {
    const block = evt.currentTarget;
    const id = block.dataset.id;

    if (block.classList.contains('selected')) {
        block.classList.remove('selected');
        selectedVoteIds = selectedVoteIds.filter(v => v !== id);
    } else {
        if (selectedVoteIds.length < imposterCount) {
            block.classList.add('selected');
            selectedVoteIds.push(id);
        } else {
            alert(`You can only select up to ${imposterCount} players.`);
        }
    }
    el('btn-vote-confirm').disabled = selectedVoteIds.length !== imposterCount;
}

function updateResult(data) {
    const pList = Object.values(data.players);
    const votesReceived = {};

    pList.forEach(voter => {
        if (voter.votes) {
            Object.keys(voter.votes).forEach(targetId => {
                votesReceived[targetId] = (votesReceived[targetId] || 0) + 1;
            });
        }
    });

    const imposters = pList.filter(p => p.role === 'Imposter').map(p => p.name).join(', ') || 'None';
    const impostersCount = data.settings?.imposters || 1;

    const playersWithVotes = pList.map(p => ({
        name: p.name,
        votes: votesReceived[p.id] || 0
    })).sort((a, b) => b.votes - a.votes);

    let selectedByVotes = [];
    if (playersWithVotes.length > 0 && playersWithVotes[0].votes > 0) {
        const voteGroups = {};
        playersWithVotes.forEach(p => {
            if (!voteGroups[p.votes]) voteGroups[p.votes] = [];
            voteGroups[p.votes].push(p.name);
        });
        const sortedCounts = Object.keys(voteGroups).map(Number).sort((a,b) => b - a);
        let remaining = impostersCount;
        for (let count of sortedCounts) {
            const group = voteGroups[count];
            if (group.length <= remaining) {
                selectedByVotes.push(...group);
                remaining -= group.length;
            } else {
                selectedByVotes.push(...group);
                break;
            }
            if (remaining <= 0) break;
        }
    }
    const selectedList = selectedByVotes.length ? selectedByVotes.join(', ') : 'None';

    let html = `
        <div class="secret-word-box">
            <p>SECRET WORD</p>
            <h1 style="color:var(--brick-red);">${data.secretWord}</h1>
            <p style="margin-top:10px; font-size:1.2rem;"><strong>🔴 Imposters (actual):</strong> ${imposters}</p>
            <p style="margin-top:5px; font-size:1.2rem;"><strong>🗳️ Selected Imposter(s) by vote:</strong> ${selectedList}</p>
        </div>
        <div style="text-align:left;">
    `;

    pList.forEach(p => {
        const isImp = p.role === 'Imposter';
        const votesGot = votesReceived[p.id] || 0;
        let votedFor = '';
        if (p.votes && typeof p.votes === 'object') {
            const targets = Object.keys(p.votes).map(id => playersCache[id]?.name || '?').join(', ');
            votedFor = targets || 'none';
        } else {
            votedFor = 'none';
        }
        html += `
            <div style="border-bottom:2px dashed #aaa; padding:5px;">
                <span style="font-size:1.4rem;">${isImp ? '🔴' : '🟢'} <b>${p.name}</b></span><br>
                <small><b>${p.name}</b> Voted <b>${votedFor}</b></small><br>
                <small>Votes Received: <b>${votesGot}</b></small>
            </div>
        `;
    });
    html += '</div>';
    el('result-content').innerHTML = html;
}

function startRevealTimer() {
    if (revealTimer) clearInterval(revealTimer);
    let timeLeft = 20;
    const disp = el('reveal-timer');
    disp.innerText = timeLeft + 's';
    revealTimer = setInterval(() => {
        timeLeft--;
        disp.innerText = timeLeft + 's';
        if (timeLeft <= 0) clearInterval(revealTimer);
    }, 1000);
}

// ==========================================
// 5. CHAT HELPERS
// ==========================================
function addChatMessage(sender, msg, target) {
    const box = el('chat-msgs');
    const priv = target !== 'ALL';
    const line = document.createElement('div');
    line.innerHTML = priv ? `<span class="msg-priv">[PRIV]</span> <b>${sender}:</b> ${msg}` : `<b>${sender}:</b> ${msg}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
}

function updateChatTargets() {
    const sel = el('chat-target');
    const currentTarget = sel.value;
    const pNames = Object.values(playersCache).map(p => p.name).filter(n => n !== me.name);
    sel.innerHTML = '<option value="ALL">All</option>';
    pNames.forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.innerText = n;
        sel.appendChild(opt);
    });
    if (pNames.includes(currentTarget)) sel.value = currentTarget;
}

// ==========================================
// 6. LOCALSTORAGE & REJOIN
// ==========================================
const STORAGE_KEY = 'spyGameMe';

function saveMeToStorage() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: me.name, room: me.room }));
}

function loadMeFromStorage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try { return JSON.parse(stored); } catch (e) { return null; }
    }
    return null;
}

function clearMeFromStorage() {
    localStorage.removeItem(STORAGE_KEY);
}

function showRejoinPrompt(stored) {
    const modal = el('rejoin-modal');
    el('rejoin-name').innerText = stored.name;
    el('rejoin-room').innerText = stored.room;
    modal.classList.remove('hidden');

    el('rejoin-yes').onclick = () => {
        modal.classList.add('hidden');
        me.name = stored.name;
        me.room = stored.room;
        socket.emit('joinRoom', { name: stored.name, roomId: stored.room });
    };
    el('rejoin-no').onclick = () => {
        modal.classList.add('hidden');
        clearMeFromStorage();
        nav('screen-start');
    };
}

// ==========================================
// 7. THEME TOGGLE (unchanged)
// ==========================================
(function() {
    const body = document.body;
    const toggleBtn = document.getElementById('theme-toggle-btn');
    const savedTheme = localStorage.getItem('theme') || 'bright';
    if (savedTheme === 'dark') {
        body.setAttribute('data-theme', 'dark');
        toggleBtn.textContent = '☀️ Bright';
    } else {
        body.removeAttribute('data-theme');
        toggleBtn.textContent = '🌙 Dark';
    }
    toggleBtn.addEventListener('click', () => {
        if (body.hasAttribute('data-theme')) {
            body.removeAttribute('data-theme');
            localStorage.setItem('theme', 'bright');
            toggleBtn.textContent = '🌙 Dark';
        } else {
            body.setAttribute('data-theme', 'dark');
            localStorage.setItem('theme', 'dark');
            toggleBtn.texttextContent = '☀️ Bright';
        }
    });
})();
