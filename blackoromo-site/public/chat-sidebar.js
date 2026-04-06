// chat-sidebar.js
(function() {
    // Створюємо HTML структуру сайдбару
    const sidebarHTML = `
        <div class="chat-sidebar">
            <button class="chat-toggle" id="chatToggleBtn">
                <i class="fas fa-comment-dots"></i>
            </button>
            <div class="chat-panel" id="chatPanel">
                <div class="chat-header">
                    <span><i class="fas fa-comment"></i> Чат з адміном</span>
                    <button id="closeChatBtn" style="background:none; border:none; color:#d4af37; cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>
                <div class="chat-messages-sidebar" id="chatMessagesSidebar"></div>
                <div class="chat-input-sidebar">
                    <input type="text" id="chatSidebarInput" placeholder="Ваше повідомлення...">
                    <button id="sendSidebarBtn">Надіслати</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', sidebarHTML);

    const socket = io();
    const chatPanel = document.getElementById('chatPanel');
    const toggleBtn = document.getElementById('chatToggleBtn');
    const closeBtn = document.getElementById('closeChatBtn');
    const messagesContainer = document.getElementById('chatMessagesSidebar');
    const input = document.getElementById('chatSidebarInput');
    const sendBtn = document.getElementById('sendSidebarBtn');

    let currentUser = null;

    // Отримання інформації про користувача
    async function fetchUser() {
        try {
            const res = await fetch('/api/user');
            if (res.ok) {
                currentUser = await res.json();
            } else {
                currentUser = null;
            }
        } catch(e) { console.log(e); }
    }

    // Додавання повідомлення в сайдбар
    function addMessage(userName, text, timestamp, isMe = false) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'chat-message';
        if (isMe) msgDiv.classList.add('me');
        const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        msgDiv.innerHTML = `<strong>${escapeHtml(userName)}</strong> <small>${timeStr}</small><br>${escapeHtml(text)}`;
        messagesContainer.appendChild(msgDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    // Завантажити історію чату
    async function loadChatHistory() {
        try {
            const res = await fetch('/api/messages');
            const msgs = await res.json();
            messagesContainer.innerHTML = '';
            msgs.forEach(msg => addMessage(msg.user_name, msg.text, msg.timestamp));
        } catch(e) { console.error(e); }
    }

    // Відправка повідомлення
    async function sendMessage(text) {
        if (!currentUser) {
            alert('Увійдіть через Google, щоб писати в чат');
            window.location.href = '/auth/google';
            return;
        }
        try {
            const res = await fetch('/api/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
            if (res.ok) {
                addMessage(currentUser.name, text, new Date(), true);
                input.value = '';
            } else {
                const err = await res.json();
                alert(err.error);
            }
        } catch(e) { alert('Помилка відправки'); }
    }

    // WebSocket слухач
    socket.on('new_message', (msg) => {
        if (currentUser && msg.user_name !== currentUser.name) {
            addMessage(msg.user_name, msg.text, msg.timestamp);
        } else if (!currentUser) {
            addMessage(msg.user_name, msg.text, msg.timestamp);
        }
    });

    // Події
    toggleBtn.addEventListener('click', () => {
        chatPanel.classList.toggle('open');
        if (chatPanel.classList.contains('open')) {
            loadChatHistory();
        }
    });
    closeBtn.addEventListener('click', () => chatPanel.classList.remove('open'));
    sendBtn.addEventListener('click', () => {
        const text = input.value.trim();
        if (text) sendMessage(text);
    });
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage(input.value.trim());
    });

    fetchUser();
})();