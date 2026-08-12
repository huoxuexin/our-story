(function () {
  'use strict';

  var LOCAL_KEY = 'my-journal-dual-v1';
  var CACHE_KEY = 'story-notes-cache-v2';
  var MIGRATED_KEY = 'story_notes_migrated_v1';
  var SUPABASE_URL = 'https://lbhovbgvrimdyutedour.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_vHKeq7kEBsft0eNYm0S4Aw_LDreBhAl';
  var OWNER_ID = '920348ff-6fad-4ad2-9125-085a22ad9ac4';

  var sb = null;
  var notes = [];
  var current = null;
  var isOwner = false;
  var dirty = false;
  var editVersion = 0;
  var saveTimer = null;

  function $(id) { return document.getElementById(id); }

  function show(id) {
    ['home', 'detail', 'readerPage'].forEach(function (name) {
      $(name).classList.toggle('hidden', name !== id);
    });
  }

  function toast(message) {
    var old = document.querySelector('.toast');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    document.body.appendChild(node);
    window.setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 2200);
  }

  function safeGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function safeSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) {}
  }

  function safeRemove(key) {
    try { window.localStorage.removeItem(key); } catch (error) {}
  }

  function withTimeout(task, milliseconds) {
    return Promise.race([
      Promise.resolve(task),
      new Promise(function (_, reject) {
        window.setTimeout(function () { reject(new Error('请求超时')); }, milliseconds);
      })
    ]);
  }

  function setOwnerUI() {
    $('new').classList.toggle('hidden', !isOwner);
    $('ownerEntry').textContent = isOwner ? '退出主人模式' : '主人登录';
    $('delete').classList.toggle('hidden', !isOwner);
    $('done').classList.toggle('hidden', !isOwner);
    $('editor').contentEditable = isOwner ? 'true' : 'false';
  }

  function setStatus(message, retry) {
    var status = $('status');
    status.innerHTML = '';
    status.classList.remove('hidden');
    var text = document.createElement('div');
    text.textContent = message;
    status.appendChild(text);
    if (retry) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = '重新加载';
      button.onclick = retry;
      status.appendChild(button);
    }
  }

  function hideStatus() { $('status').classList.add('hidden'); }

  function normalizeRows(rows) {
    return (rows || []).map(function (item) {
      return {
        id: String(item.id),
        text: item.content || '',
        updated: new Date(item.updated_at || item.created_at || Date.now()).getTime()
      };
    });
  }

  function readCache() {
    try {
      var cached = JSON.parse(safeGet(CACHE_KEY) || '[]');
      return Array.isArray(cached) ? cached : [];
    } catch (error) {
      return [];
    }
  }

  function writeCache() { safeSet(CACHE_KEY, JSON.stringify(notes.slice(0, 20))); }

  function renderList() {
    var list = $('list');
    list.innerHTML = '';
    if (!notes.length) {
      setStatus('这里还没有随笔');
      return;
    }
    hideStatus();
    notes.slice(0, 4).forEach(function (note) {
      var item = document.createElement('div');
      var date = document.createElement('div');
      var preview = document.createElement('div');
      item.className = 'note';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      date.className = 'date';
      date.textContent = new Date(note.updated).toLocaleString();
      preview.className = 'preview';
      preview.textContent = note.text || '空白随笔';
      item.appendChild(date);
      item.appendChild(preview);
      item.onclick = function () { isOwner ? openEdit(note.id) : openRead(note.id); };
      item.onkeydown = function (event) {
        if ((event.key || event.keyCode) === 'Enter' || event.keyCode === 13) item.click();
      };
      list.appendChild(item);
    });
  }

  function showCachedOrError() {
    var cached = readCache();
    if (cached.length) {
      notes = cached;
      renderList();
      toast('网络较慢，已显示上次内容');
    } else {
      setStatus('暂时未能加载，请检查网络后重试', loadNotes);
    }
  }

  async function loadNotes() {
    if (!sb) { showCachedOrError(); return; }
    setStatus('正在加载……');
    try {
      var result = await withTimeout(
        sb.from('story_notes').select('id,title,content,created_at,updated_at').order('updated_at', { ascending: false }),
        15000
      );
      if (result.error) throw result.error;
      notes = normalizeRows(result.data);
      writeCache();
      renderList();
    } catch (error) {
      showCachedOrError();
    }
  }

  async function loadSharedNote(id) {
    show('readerPage');
    $('reader').textContent = '正在加载……';
    if (!sb) {
      $('reader').textContent = '暂时无法打开这篇随笔，请稍后重试。';
      return;
    }
    try {
      var result = await withTimeout(
        sb.from('story_notes').select('id,content,updated_at').eq('id', Number(id)).limit(1),
        15000
      );
      if (result.error) throw result.error;
      if (!result.data || !result.data.length) {
        $('reader').textContent = '这篇随笔不存在，或暂时无法查看。';
        return;
      }
      $('reader').textContent = result.data[0].content || '空白随笔';
    } catch (error) {
      $('reader').textContent = '暂时无法打开这篇随笔，请稍后重试。';
    }
  }

  async function migrateLocalOnce() {
    if (!isOwner || safeGet(MIGRATED_KEY) || !sb) return;
    var local = [];
    try { local = JSON.parse(safeGet(LOCAL_KEY) || '[]'); } catch (error) {}
    if (!Array.isArray(local) || !local.length) {
      safeSet(MIGRATED_KEY, '1');
      return;
    }
    try {
      var countResult = await sb.from('story_notes').select('*', { count: 'exact', head: true });
      if (countResult.error) throw countResult.error;
      if (countResult.count === 0) {
        var base = Date.now();
        var rows = local.map(function (note, index) {
          var time = new Date(note.updated || Date.now()).toISOString();
          return { id: base + index, title: '', content: note.text || '', created_at: time, updated_at: time };
        });
        var insertResult = await sb.from('story_notes').insert(rows);
        if (insertResult.error) throw insertResult.error;
        toast('原来的随笔已同步到云端');
      }
      safeSet(MIGRATED_KEY, '1');
      await loadNotes();
    } catch (error) {
      toast('原来的随笔暂未同步，请稍后再试');
    }
  }

  async function newNote() {
    if (!isOwner || !sb) return;
    var id = Date.now();
    var now = new Date().toISOString();
    try {
      var result = await sb.from('story_notes').insert({ id: id, title: '', content: '', created_at: now, updated_at: now });
      if (result.error) throw result.error;
      await loadNotes();
      openEdit(String(id));
    } catch (error) {
      toast('新建失败，请稍后重试');
    }
  }

  function openEdit(id) {
    if (!isOwner) { openRead(id); return; }
    current = String(id);
    var note = notes.find(function (item) { return item.id === current; });
    $('editor').textContent = note ? note.text : '';
    dirty = false;
    editVersion = 0;
    setOwnerUI();
    show('detail');
    window.setTimeout(function () { $('editor').focus(); }, 60);
  }

  function openRead(id) {
    current = String(id);
    var note = notes.find(function (item) { return item.id === current; });
    if (!note) { loadSharedNote(id); return; }
    $('reader').textContent = note.text || '空白随笔';
    show('readerPage');
  }

  async function save(silent) {
    if (!isOwner || !current || !dirty || !sb) return true;
    var text = $('editor').innerText;
    var versionAtStart = editVersion;
    var updated = new Date().toISOString();
    try {
      var result = await sb.from('story_notes').update({ content: text, updated_at: updated }).eq('id', Number(current));
      if (result.error) throw result.error;
      var note = notes.find(function (item) { return item.id === current; });
      if (note) { note.text = text; note.updated = Date.now(); }
      if (versionAtStart === editVersion) dirty = false;
      writeCache();
      return true;
    } catch (error) {
      if (!silent) toast('保存失败，请检查网络');
      return false;
    }
  }

  async function deleteNote() {
    if (!isOwner || !current || !sb) return;
    if (!window.confirm('确定删除这篇随笔吗？')) return;
    try {
      var result = await sb.from('story_notes').delete().eq('id', Number(current));
      if (result.error) throw result.error;
      current = null;
      dirty = false;
      await loadNotes();
      show('home');
      toast('已删除');
    } catch (error) {
      toast('删除失败，请稍后重试');
    }
  }

  function getQueryParam(name) {
    var pattern = new RegExp('[?&]' + name + '=([^&#]*)');
    var match = pattern.exec(window.location.search);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : '';
  }

  function decodeLegacy(value) {
    var input = value.replace(/-/g, '+').replace(/_/g, '/');
    while (input.length % 4) input += '=';
    return decodeURIComponent(escape(window.atob(input)));
  }

  function cleanBaseUrl() {
    return window.location.href.split('?')[0].split('#')[0];
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', 'readonly');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try {
        if (!document.execCommand('copy')) throw new Error('copy failed');
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        document.body.removeChild(input);
      }
    });
  }

  async function shareNote() {
    if (!current) return;
    if (!(await save(false))) return;
    var url = cleanBaseUrl() + '?note=' + encodeURIComponent(current);
    if (navigator.share) {
      try {
        await navigator.share({ title: '随笔', text: '分享给你一篇随笔', url: url });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    try {
      await copyText(url);
      toast('只读链接已复制');
    } catch (error) {
      window.prompt('复制这个链接：', url);
    }
  }

  async function refreshSession() {
    if (!sb) { isOwner = false; setOwnerUI(); return; }
    try {
      var result = await withTimeout(sb.auth.getSession(), 12000);
      var session = result.data && result.data.session;
      isOwner = Boolean(session && session.user && session.user.id === OWNER_ID);
    } catch (error) {
      isOwner = false;
    }
    setOwnerUI();
  }

  function openLogin() {
    if (!sb) { toast('连接尚未就绪，请稍后重试'); return; }
    $('loginMask').classList.remove('hidden');
    window.setTimeout(function () { $('loginPassword').focus(); }, 60);
  }

  function closeLogin() {
    $('loginMask').classList.add('hidden');
    $('loginPassword').value = '';
  }

  async function submitLogin() {
    if (!sb) return;
    var email = $('loginEmail').value.trim();
    var password = $('loginPassword').value;
    $('loginSubmit').disabled = true;
    try {
      var result = await withTimeout(sb.auth.signInWithPassword({ email: email, password: password }), 15000);
      var user = result.data && result.data.user;
      if (result.error || !user || user.id !== OWNER_ID) {
        if (result.data && result.data.session) await sb.auth.signOut();
        toast('邮箱或密码不正确');
        return;
      }
      closeLogin();
      isOwner = true;
      setOwnerUI();
      await migrateLocalOnce();
      toast('已进入主人模式');
    } catch (error) {
      toast('登录失败，请检查网络');
    } finally {
      $('loginSubmit').disabled = false;
    }
  }

  function bindEvents() {
    $('ownerEntry').onclick = async function () {
      if (!isOwner) { openLogin(); return; }
      try { await sb.auth.signOut(); } catch (error) {}
      isOwner = false;
      setOwnerUI();
      await loadNotes();
      toast('已退出主人模式');
    };
    $('loginCancel').onclick = closeLogin;
    $('loginSubmit').onclick = submitLogin;
    $('loginPassword').addEventListener('keydown', function (event) {
      if ((event.key && event.key === 'Enter') || event.keyCode === 13) $('loginSubmit').click();
    });
    $('new').onclick = newNote;
    $('back').onclick = async function () { await save(false); await loadNotes(); show('home'); };
    $('done').onclick = async function () { await save(false); await loadNotes(); show('home'); };
    $('delete').onclick = deleteNote;
    $('share').onclick = shareNote;
    $('editor').oninput = function () {
      if (!isOwner) return;
      dirty = true;
      editVersion += 1;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(function () { save(true); }, 900);
    };
    $('editor').addEventListener('paste', function (event) {
      if (!isOwner) return;
      event.preventDefault();
      var clipboard = event.clipboardData || window.clipboardData;
      var text = clipboard ? clipboard.getData('text') : '';
      document.execCommand('insertText', false, text);
    });
    $('readerBack').onclick = function () {
      window.history.replaceState(null, '', window.location.pathname);
      renderList();
      show('home');
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && dirty) save(true);
    });
  }

  function initClient() {
    try {
      if (!window.supabase || typeof window.supabase.createClient !== 'function') return false;
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
      });
      return true;
    } catch (error) {
      sb = null;
      return false;
    }
  }

  async function boot() {
    bindEvents();
    initClient();
    await refreshSession();

    var legacy = window.location.hash.indexOf('#read=') === 0 ? window.location.hash.slice(6) : '';
    if (legacy) {
      try {
        $('reader').textContent = decodeLegacy(legacy);
        show('readerPage');
      } catch (error) {
        await loadNotes();
        show('home');
      }
      return;
    }

    var sharedId = getQueryParam('note');
    if (sharedId && /^\d+$/.test(sharedId)) {
      await loadSharedNote(sharedId);
      return;
    }

    await loadNotes();
    show('home');
  }

  window.addEventListener('unhandledrejection', function () {
    if (!$('home').classList.contains('hidden')) showCachedOrError();
  });

  boot();
})();
