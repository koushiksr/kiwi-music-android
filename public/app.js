// Environment Detection
const isElectron = (window.kiwiAPI !== undefined);
const isCapacitor = (window.Capacitor !== undefined);

function getBypassedUrl(url) {
  if (isElectron || isCapacitor) {
    return url;
  }
  // Standard web browser - proxy via server.js
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

// State Management
let songs = [];
let filteredSongs = [];
let currentCategory = 'music'; // 'music' or 'speech'
let currentSongIndex = -1;
let isPlaying = false;
let isMuted = false;
let previousVolume = 0.8;

// Playback Queue System
let playQueue = [];

// Management / Selection States
let isManaging = false;
const selectedSongIds = new Set();

// Navigation Panel Elements
const navLibraryBtn = document.getElementById('nav-library-btn');
const navQueueBtn = document.getElementById('nav-queue-btn');
const navDownloaderBtn = document.getElementById('nav-downloader-btn');

const libraryView = document.getElementById('library-view');
const queueView = document.getElementById('queue-view');
const downloaderView = document.getElementById('downloader-view');
const sidebarSearchCard = document.getElementById('sidebar-search-card');

// Audio & DOM Elements
const audio = document.getElementById('audio-player');
const songsListContainer = document.getElementById('songs-list');
const queueListContainer = document.getElementById('queue-list-container');
const songsFoundText = document.getElementById('songs-found-text');
const queueCountText = document.getElementById('queue-count-text');
const queueBadge = document.getElementById('queue-badge');
const searchInput = document.getElementById('search-input');
const refreshBtn = document.getElementById('refresh-btn');
const clearQueueBtn = document.getElementById('clear-queue-btn');

// Category Tab Controls
const tabMusic = document.getElementById('tab-music');
const tabSpeech = document.getElementById('tab-speech');

// Management / Selection Elements
const manageLibraryBtn = document.getElementById('manage-library-btn');
const bulkActionsBar = document.getElementById('bulk-actions-bar');
const selectedCountText = document.getElementById('selected-count-text');
const selectAllBtn = document.getElementById('select-all-btn');
const deleteSelectedBtn = document.getElementById('delete-selected-btn');
const cancelBulkBtn = document.getElementById('cancel-bulk-btn');
const songsSectionContainer = document.getElementById('songs-section-container');
const headerSelectAllCheckbox = document.getElementById('header-select-all-checkbox');

// Player Controls
const playBtn = document.getElementById('play-btn');
const playBtnIconContainer = document.getElementById('play-btn-icon');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const progressWrapper = document.getElementById('progress-wrapper');
const progressFill = document.getElementById('progress-fill');
const playerDrawer = document.querySelector('.player-drawer');

// Now Playing Meta
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const playingArtIcon = document.getElementById('playing-art-icon');

// Volume Elements
const volumeToggle = document.getElementById('volume-toggle');
const volumeIcon = document.getElementById('volume-icon');
const volumeSliderWrapper = document.getElementById('volume-slider-wrapper');
const volumeFill = document.getElementById('volume-fill');

// Downloader Elements
const dlSongName = document.getElementById('dl-song-name');
const dlLanguage = document.getElementById('dl-language');
const dlSearchBtn = document.getElementById('dl-search-btn');
const downloaderResults = document.getElementById('downloader-results');

// Hidden Mobile File Import Elements
const refreshBtnText = document.getElementById('refresh-btn-text');
const mobileFileInput = document.getElementById('mobile-file-input');

// Initialize Icons
if (window.lucide) {
  window.lucide.createIcons();
}

// ----------------------------------------------------
// 0. Mobile IndexedDB & Environment Init
// ----------------------------------------------------
let db;

if (!isElectron) {
  // Update button text for mobile file imports
  if (refreshBtnText) refreshBtnText.innerText = 'Import Audio Files';
  if (refreshBtn) refreshBtn.title = 'Import local songs from your mobile device';

  // Initialize IndexedDB
  const dbRequest = indexedDB.open('KiwiMusicDB', 1);
  dbRequest.onupgradeneeded = (e) => {
    db = e.target.result;
    if (!db.objectStoreNames.contains('songs')) {
      db.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
    }
  };
  dbRequest.onsuccess = (e) => {
    db = e.target.result;
    loadSongs();
  };
  dbRequest.onerror = (e) => {
    console.error('Failed to open IndexedDB:', e);
  };
}

// Trigger file input dialog on mobile
refreshBtn.addEventListener('click', () => {
  if (isElectron) {
    toggleManageMode(false);
    loadSongs();
  } else {
    if (mobileFileInput) mobileFileInput.click();
  }
});

if (mobileFileInput) {
  mobileFileInput.addEventListener('change', async (e) => {
    const filesList = e.target.files;
    if (!filesList.length) return;

    songsListContainer.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Importing audio files to your offline library...</p>
      </div>
    `;

    try {
      for (const file of filesList) {
        await addSongToIndexedDB(file);
      }
    } catch (err) {
      console.error('Import failed:', err);
      alert(`Import failed: ${err.message || err}`);
    }
    mobileFileInput.value = ''; // Reset file input
    loadSongs();
  });
}

function addSongToIndexedDB(file) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error("Database not initialized. Please try again."));
      return;
    }
    
    // Copy File object to a clean standard Blob.
    // Android WebViews prevent storing native File handles due to security constraints.
    const fileBlob = new Blob([file], { type: file.type || 'audio/mpeg' });

    const transaction = db.transaction(['songs'], 'readwrite');
    const store = transaction.objectStore('songs');
    
    const metadata = clientCleanSongMetadata(file.name);
    const category = clientClassifyAudio(file.name);
    
    const songData = {
      title: metadata.title,
      artist: metadata.artist,
      filename: file.name,
      size: file.size,
      folder: 'Imported',
      category: category,
      mtime: Date.now(),
      blob: fileBlob // Store binary Blob directly
    };
    
    const request = store.add(songData);
    request.onsuccess = () => resolve();
    request.onerror = (err) => reject(err);
  });
}

function getIndexedDBSongs() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['songs'], 'readonly');
    const store = transaction.objectStore('songs');
    const request = store.getAll();
    request.onsuccess = (e) => resolve(e.target.result || []);
    request.onerror = (err) => reject(err);
  });
}

function deleteIndexedDBSong(id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['songs'], 'readwrite');
    const store = transaction.objectStore('songs');
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = (err) => reject(err);
  });
}

// Custom HTML for combined Play/Pause SVG icon symbol
function getPlayPauseIconHtml(playing) {
  if (playing) {
    return `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="display: block;">
        <polygon points="4 3 13 12 4 21 4 3" fill="currentColor"></polygon>
        <line x1="17" y1="4" x2="17" y2="20" stroke-width="3.5"></line>
        <line x1="22" y1="4" x2="22" y2="20" stroke-width="3.5"></line>
      </svg>
    `;
  } else {
    return `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="display: block;">
        <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>
      </svg>
    `;
  }
}

// Format bytes helper
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getFolderClass(folder) {
  return folder.toLowerCase().replace(/\s+/g, '-');
}

// Dice coefficient bigram fuzzy string matching algorithm for typo tolerance
function diceCoefficient(str1, str2) {
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  if (s1 === s2) return 1.0;
  if (s1.length < 2 || s2.length < 2) return 0.0;
  
  const bigrams1 = new Map();
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substr(i, 2);
    const count = bigrams1.has(bigram) ? bigrams1.get(bigram) + 1 : 1;
    bigrams1.set(bigram, count);
  }
  
  let intersection = 0;
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substr(i, 2);
    const count = bigrams1.has(bigram) ? bigrams1.get(bigram) : 0;
    if (count > 0) {
      bigrams1.set(bigram, count - 1);
      intersection++;
    }
  }
  
  return (2.0 * intersection) / (s1.length + s2.length - 2);
}

// Helper to generate a safe DOM element ID from a URL (replaces unsafe characters instead of throwing in btoa)
function getSafeElementId(url) {
  return 'card_' + url.replace(/[^a-zA-Z0-9]/g, '');
}

// ----------------------------------------------------
// 1. Navigation Panel Switches
// ----------------------------------------------------
navLibraryBtn.addEventListener('click', () => {
  navLibraryBtn.classList.add('active');
  navQueueBtn.classList.remove('active');
  navDownloaderBtn.classList.remove('active');
  
  libraryView.classList.remove('hidden');
  queueView.classList.add('hidden');
  downloaderView.classList.add('hidden');
  sidebarSearchCard.classList.remove('hidden');
  toggleManageMode(false);
});

navQueueBtn.addEventListener('click', () => {
  navQueueBtn.classList.add('active');
  navLibraryBtn.classList.remove('active');
  navDownloaderBtn.classList.remove('active');
  
  queueView.classList.remove('hidden');
  libraryView.classList.add('hidden');
  downloaderView.classList.add('hidden');
  sidebarSearchCard.classList.add('hidden');
  toggleManageMode(false);
  renderQueueList();
});

navDownloaderBtn.addEventListener('click', () => {
  navDownloaderBtn.classList.add('active');
  navLibraryBtn.classList.remove('active');
  navQueueBtn.classList.remove('active');
  
  downloaderView.classList.remove('hidden');
  libraryView.classList.add('hidden');
  queueView.classList.add('hidden');
  sidebarSearchCard.classList.add('hidden');
  toggleManageMode(false);
});

// ----------------------------------------------------
// 2. Core Song Loading and UI Display (IPC / IndexedDB)
// ----------------------------------------------------
async function loadSongs() {
  songsListContainer.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Scanning files in memory...</p>
    </div>
  `;

  try {
    if (isElectron) {
      songs = await window.kiwiAPI.scanSongs();
    } else {
      if (db) {
        songs = await getIndexedDBSongs();
      } else {
        songs = [];
      }
    }
    applyFilter();
  } catch (error) {
    console.error('Failed to scan songs:', error);
    songsListContainer.innerHTML = `
      <div class="no-songs-state">
        <i data-lucide="alert-circle" style="color: #f35588"></i>
        <h4>Failed to scan library</h4>
        <p>Ensure the application has proper permissions.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

function applyFilter() {
  const query = searchInput.value.toLowerCase().trim();
  
  if (query === '') {
    filteredSongs = songs.filter(song => song.category === currentCategory);
  } else {
    // Sort songs based on search relevance matching typos/substrings
    const matches = [];

    songs.forEach(song => {
      if (song.category !== currentCategory) return;
      
      const title = song.title.toLowerCase();
      const artist = song.artist.toLowerCase();
      const filename = song.filename.toLowerCase();
      
      // Match 1: Exact Substring match (100% relevance)
      if (title.includes(query) || artist.includes(query) || filename.includes(query)) {
        matches.push({ song, score: 1.0 });
        return;
      }
      
      // Match 2: Out of order multi-word lookup
      const queryWords = query.split(/\s+/);
      const songWords = title.split(/\s+/).concat(artist.split(/\s+/));
      let wordMatches = 0;
      queryWords.forEach(qw => {
        if (songWords.some(sw => sw.includes(qw))) wordMatches++;
      });
      
      if (wordMatches > 0) {
        matches.push({ song, score: (wordMatches / queryWords.length) * 0.8 });
        return;
      }
      
      // Match 3: Typo/Spelling mismatch tolerance using bigram Dice Coefficient
      const titleScore = diceCoefficient(query, title);
      const artistScore = diceCoefficient(query, artist);
      const maxScore = Math.max(titleScore, artistScore);
      
      if (maxScore > 0.25) {
        matches.push({ song, score: maxScore * 0.6 }); // Weight slightly below direct matches
      }
    });

    matches.sort((a, b) => b.score - a.score);
    filteredSongs = matches.map(m => m.song);
  }

  // Adjust selection elements if visible list changes
  const visibleIds = new Set(filteredSongs.map(s => s.id));
  for (const id of selectedSongIds) {
    if (!visibleIds.has(id)) {
      selectedSongIds.delete(id);
    }
  }
  updateBulkUI();
  renderSongs(filteredSongs);
}

function renderSongs(songsToRender) {
  const typeLabel = currentCategory === 'music' ? 'Music Tracks' : 'Spoken Audio Files';
  songsFoundText.innerText = `${songsToRender.length} ${typeLabel} Found`;
  
  if (songsToRender.length === 0) {
    songsListContainer.innerHTML = `
      <div class="no-songs-state">
        <i data-lucide="${currentCategory === 'music' ? 'music-2' : 'mic-2'}"></i>
        <h4>No files found in this category</h4>
        <p>Try searching another term, or verify that files exist in scanned folders.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  songsListContainer.innerHTML = '';
  songsToRender.forEach((song, index) => {
    const mainIndex = songs.findIndex(s => s.id === song.id);
    const isChecked = selectedSongIds.has(song.id);
    const isCurrentActive = mainIndex === currentSongIndex;

    const row = document.createElement('div');
    row.className = `song-row ${isCurrentActive ? 'active' : ''}`;
    row.id = `song-row-${mainIndex}`;
    row.onclick = () => {
      if (isManaging) {
        const cb = row.querySelector('.song-checkbox');
        if (cb) {
          cb.checked = !cb.checked;
          const e = { target: cb };
          toggleSongSelection(e);
        }
      } else {
        playSong(mainIndex);
      }
    };

    row.innerHTML = `
      <div class="col-checkbox" onclick="event.stopPropagation()">
        <input type="checkbox" class="song-checkbox" data-id="${song.id}" ${isChecked ? 'checked' : ''} onchange="toggleSongSelection(event)">
      </div>
      <div class="col-index">${index + 1}</div>
      <div class="col-title song-title-wrapper">
        <span class="song-title">${song.title}</span>
        <span class="song-filename">${song.filename}</span>
      </div>
      <div class="col-artist">${song.artist}</div>
      <div class="col-folder">
        <span class="folder-tag ${getFolderClass(song.folder)}">${song.folder}</span>
      </div>
      <div class="col-size">${formatBytes(song.size)}</div>
      <div class="col-action">
        <button class="delete-row-btn" onclick="event.stopPropagation(); deleteSingleSong('${song.id}', '${song.title.replace(/'/g, "\\'")}')" title="Delete song">
          <i data-lucide="trash-2"></i>
        </button>
        <button class="queue-row-btn" onclick="event.stopPropagation(); addToQueue('${song.id}')" title="Add to queue">
          <i data-lucide="plus-circle"></i>
        </button>
        <button class="play-row-btn" aria-label="Play">
          <span class="row-play-icon-wrapper">
            ${isCurrentActive && isPlaying ? getPlayPauseIconHtml(true) : getPlayPauseIconHtml(false)}
          </span>
        </button>
      </div>
    `;
    songsListContainer.appendChild(row);
  });

  if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// 3. Tab Filter Switching Events
// ----------------------------------------------------
tabMusic.addEventListener('click', () => {
  if (currentCategory !== 'music') {
    currentCategory = 'music';
    tabMusic.classList.add('active');
    tabSpeech.classList.remove('active');
    toggleManageMode(false);
    applyFilter();
  }
});

tabSpeech.addEventListener('click', () => {
  if (currentCategory !== 'speech') {
    currentCategory = 'speech';
    tabSpeech.classList.add('active');
    tabMusic.classList.remove('active');
    toggleManageMode(false);
    applyFilter();
  }
});

// Debounced Search Input handler
let searchDebounceTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounceTimeout);
  searchDebounceTimeout = setTimeout(applyFilter, 80); // 80ms debounce
});

// ----------------------------------------------------
// 4. Playback Functions
// ----------------------------------------------------
function playSong(index) {
  if (index < 0 || index >= songs.length) return;

  if (currentSongIndex === index) {
    togglePlay();
    return;
  }

  currentSongIndex = index;
  const song = songs[currentSongIndex];

  if (song.category === 'speech') {
    playingArtIcon.setAttribute('data-lucide', 'mic');
  } else {
    playingArtIcon.setAttribute('data-lucide', 'music');
  }

  if (isElectron) {
    audio.src = `file:///${song.path.replace(/\\/g, '/')}`;
  } else {
    if (audio.src && audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(audio.src);
    }
    audio.src = URL.createObjectURL(song.blob);
  }

  audio.load();
  audio.play()
    .then(() => {
      isPlaying = true;
      updatePlayerUI();
      updateSongRowStates();
    })
    .catch(err => {
      console.error('Audio playback failed:', err);
    });
}

function togglePlay() {
  if (isPlaying) {
    audio.pause();
    isPlaying = false;
  } else {
    if (currentSongIndex === -1) {
      if (filteredSongs.length > 0) {
        const firstFiltered = filteredSongs[0];
        const mainIdx = songs.findIndex(s => s.id === firstFiltered.id);
        playSong(mainIdx);
      } else if (songs.length > 0) {
        playSong(0);
      }
      return;
    }
    audio.play().catch(e => console.error(e));
    isPlaying = true;
  }
  updatePlayerUI();
  updateSongRowStates();
}

function playNext() {
  if (songs.length === 0) return;

  // 1. Play from Playback Queue first
  if (playQueue.length > 0) {
    const nextQueuedSong = playQueue.shift();
    updateQueueBadgeUI();
    
    const mainIdx = songs.findIndex(s => s.id === nextQueuedSong.id);
    if (mainIdx !== -1) {
      playSong(mainIdx);
      if (!queueView.classList.contains('hidden')) {
        renderQueueList();
      }
      return;
    }
  }
  
  // 2. Normal sequential playback fallback
  if (filteredSongs.length > 0 && currentSongIndex !== -1) {
    const currentFilteredIndex = filteredSongs.findIndex(s => s.id === songs[currentSongIndex].id);
    if (currentFilteredIndex !== -1) {
      let nextFiltered = currentFilteredIndex + 1;
      if (nextFiltered >= filteredSongs.length) nextFiltered = 0;
      const targetSong = filteredSongs[nextFiltered];
      const mainIdx = songs.findIndex(s => s.id === targetSong.id);
      playSong(mainIdx);
      return;
    }
  }

  let nextIndex = currentSongIndex + 1;
  if (nextIndex >= songs.length) nextIndex = 0;
  playSong(nextIndex);
}

function playPrevious() {
  if (songs.length === 0) return;

  if (filteredSongs.length > 0 && currentSongIndex !== -1) {
    const currentFilteredIndex = filteredSongs.findIndex(s => s.id === songs[currentSongIndex].id);
    if (currentFilteredIndex !== -1) {
      let prevFiltered = currentFilteredIndex - 1;
      if (prevFiltered < 0) prevFiltered = filteredSongs.length - 1;
      const targetSong = filteredSongs[prevFiltered];
      const mainIdx = songs.findIndex(s => s.id === targetSong.id);
      playSong(mainIdx);
      return;
    }
  }

  let prevIndex = currentSongIndex - 1;
  if (prevIndex < 0) prevIndex = songs.length - 1;
  playSong(prevIndex);
}

function updateSongRowStates() {
  document.querySelectorAll('.song-row').forEach(row => {
    row.classList.remove('active');
    const playIconWrapper = row.querySelector('.row-play-icon-wrapper');
    if (playIconWrapper) {
      playIconWrapper.innerHTML = getPlayPauseIconHtml(false);
    }
  });

  const activeRow = document.getElementById(`song-row-${currentSongIndex}`);
  if (activeRow) {
    activeRow.classList.add('active');
    const playIconWrapper = activeRow.querySelector('.row-play-icon-wrapper');
    if (playIconWrapper) {
      playIconWrapper.innerHTML = getPlayPauseIconHtml(isPlaying);
    }
  }

  if (window.lucide) window.lucide.createIcons();
}

function updatePlayerUI() {
  if (currentSongIndex !== -1) {
    const song = songs[currentSongIndex];
    if (song) {
      playerTitle.innerText = song.title;
      playerArtist.innerText = song.artist;
    }
  } else {
    playerTitle.innerText = 'No Song Playing';
    playerArtist.innerText = 'Select an audio file';
    playingArtIcon.setAttribute('data-lucide', 'music');
  }
  
  if (isPlaying) {
    playerDrawer.classList.add('playing');
    playBtnIconContainer.innerHTML = getPlayPauseIconHtml(true);
  } else {
    playerDrawer.classList.remove('playing');
    playBtnIconContainer.innerHTML = getPlayPauseIconHtml(false);
  }

  if (window.lucide) window.lucide.createIcons();
}

// ----------------------------------------------------
// 5. Audio Time and Volume Handling
// ----------------------------------------------------
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

audio.addEventListener('timeupdate', () => {
  const duration = audio.duration || 0;
  const current = audio.currentTime || 0;
  
  currentTimeEl.innerText = formatTime(current);
  durationTimeEl.innerText = formatTime(duration);

  if (duration > 0) {
    const percent = (current / duration) * 100;
    progressFill.style.width = `${percent}%`;
  } else {
    progressFill.style.width = '0%';
  }
});

audio.addEventListener('loadedmetadata', () => {
  durationTimeEl.innerText = formatTime(audio.duration);
});

audio.addEventListener('ended', () => {
  playNext();
});

progressWrapper.addEventListener('click', (e) => {
  const rect = progressWrapper.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const width = rect.width;
  const percentage = clickX / width;
  
  if (audio.duration) {
    audio.currentTime = percentage * audio.duration;
  }
});

function setVolume(val) {
  audio.volume = val;
  volumeFill.style.width = `${val * 100}%`;
  
  if (val === 0) {
    volumeIcon.setAttribute('data-lucide', 'volume-x');
  } else if (val < 0.4) {
    volumeIcon.setAttribute('data-lucide', 'volume-1');
  } else {
    volumeIcon.setAttribute('data-lucide', 'volume-2');
  }
  if (window.lucide) window.lucide.createIcons();
}

volumeSliderWrapper.addEventListener('click', (e) => {
  const rect = volumeSliderWrapper.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const width = rect.width;
  const percentage = Math.max(0, Math.min(1, clickX / width));
  
  isMuted = false;
  previousVolume = percentage;
  setVolume(percentage);
});

volumeToggle.addEventListener('click', () => {
  if (isMuted) {
    isMuted = false;
    setVolume(previousVolume);
  } else {
    previousVolume = audio.volume;
    isMuted = true;
    setVolume(0);
  }
});

playBtn.addEventListener('click', togglePlay);
prevBtn.addEventListener('click', playPrevious);
nextBtn.addEventListener('click', playNext);

// ----------------------------------------------------
// 6. Management / Library Deletion Logic
// ----------------------------------------------------
manageLibraryBtn.addEventListener('click', () => {
  toggleManageMode();
});

cancelBulkBtn.addEventListener('click', () => {
  toggleManageMode(false);
});

function toggleManageMode(forceState) {
  isManaging = typeof forceState === 'boolean' ? forceState : !isManaging;
  selectedSongIds.clear();
  headerSelectAllCheckbox.checked = false;

  if (isManaging) {
    manageLibraryBtn.classList.add('active');
    bulkActionsBar.classList.remove('hidden');
    songsSectionContainer.classList.add('managing');
  } else {
    manageLibraryBtn.classList.remove('active');
    bulkActionsBar.classList.add('hidden');
    songsSectionContainer.classList.remove('managing');
  }

  updateBulkUI();
  renderSongs(filteredSongs);
}

function updateBulkUI() {
  selectedCountText.innerText = `${selectedSongIds.size} items selected`;
}

window.toggleSongSelection = (event) => {
  const id = event.target.getAttribute('data-id');
  const numericId = isNaN(id) ? id : parseInt(id, 10);
  
  if (event.target.checked) {
    selectedSongIds.add(numericId);
  } else {
    selectedSongIds.delete(numericId);
  }
  updateBulkUI();

  // Keep header checkbox synced
  const visibleIds = filteredSongs.map(s => s.id);
  const allChecked = visibleIds.every(p => selectedSongIds.has(p));
  headerSelectAllCheckbox.checked = allChecked && visibleIds.length > 0;
};

// Header Checkbox select all handler
headerSelectAllCheckbox.addEventListener('change', (e) => {
  const checked = e.target.checked;
  filteredSongs.forEach(song => {
    if (checked) {
      selectedSongIds.add(song.id);
    } else {
      selectedSongIds.delete(song.id);
    }
  });
  updateBulkUI();

  document.querySelectorAll('.song-checkbox').forEach(cb => {
    cb.checked = checked;
  });
});

// Select All Button Handler
selectAllBtn.addEventListener('click', () => {
  filteredSongs.forEach(song => {
    selectedSongIds.add(song.id);
  });
  headerSelectAllCheckbox.checked = true;
  updateBulkUI();

  document.querySelectorAll('.song-checkbox').forEach(cb => {
    cb.checked = true;
  });
});

// Delete Single Song handler
window.deleteSingleSong = async (id, title) => {
  const confirmed = confirm(`Are you sure you want to permanently delete "${title}"?\nThis cannot be undone.`);
  if (!confirmed) return;

  const numericId = isNaN(id) ? id : parseInt(id, 10);

  try {
    if (isElectron) {
      const song = songs.find(s => s.id === id || s.path === id);
      const targetPath = song ? song.path : id;
      const results = await window.kiwiAPI.deleteSongs([targetPath]);
      if (!results[0] || !results[0].success) {
        throw new Error(results[0] ? results[0].error : 'Failed to delete file');
      }
    } else {
      await deleteIndexedDBSong(numericId);
    }
    
    // If the deleted song was playing, stop audio
    if (currentSongIndex !== -1 && (songs[currentSongIndex].id === id || songs[currentSongIndex].path === id)) {
      audio.pause();
      isPlaying = false;
      currentSongIndex = -1;
      updatePlayerUI();
    }
    
    // Also pop from play queue if present
    playQueue = playQueue.filter(s => s.id !== id && s.path !== id);
    updateQueueBadgeUI();

    loadSongs();
  } catch (err) {
    console.error('Delete song failed:', err);
    alert(`Failed to delete file: ${err.message || err}`);
  }
};

// Bulk Delete Selected Songs handler
deleteSelectedBtn.addEventListener('click', async () => {
  if (selectedSongIds.size === 0) {
    alert('Please select at least one song to delete.');
    return;
  }

  const confirmed = confirm(`Are you sure you want to permanently delete these ${selectedSongIds.size} selected songs?\nThis cannot be undone.`);
  if (!confirmed) return;

  const idsArray = [...selectedSongIds];
  try {
    if (isElectron) {
      const pathsArray = idsArray.map(id => {
        const song = songs.find(s => s.id === id || s.path === id);
        return song ? song.path : id;
      });
      const results = await window.kiwiAPI.deleteSongs(pathsArray);
      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => !r.success).length;

      alert(`Successfully deleted ${succeeded} songs.${failed > 0 ? ` Failed to delete ${failed} files.` : ''}`);
    } else {
      for (const id of idsArray) {
        await deleteIndexedDBSong(id);
      }
      alert('Successfully deleted selected songs.');
    }

    // If currently playing song is in the deleted set, stop audio
    if (currentSongIndex !== -1 && (selectedSongIds.has(songs[currentSongIndex].id) || selectedSongIds.has(songs[currentSongIndex].path))) {
      audio.pause();
      isPlaying = false;
      currentSongIndex = -1;
      updatePlayerUI();
    }

    // Filter out from queue
    playQueue = playQueue.filter(s => !selectedSongIds.has(s.id) && !selectedSongIds.has(s.path));
    updateQueueBadgeUI();

    toggleManageMode(false);
    loadSongs();
  } catch (err) {
    console.error('Bulk deletion failed:', err);
    alert('Failed to execute bulk delete.');
  }
});

// ----------------------------------------------------
// 7. Playback Queue Logic
// ----------------------------------------------------
window.addToQueue = (songId) => {
  const numericId = isNaN(songId) ? songId : parseInt(songId, 10);
  const song = songs.find(s => s.id === numericId);
  if (!song) return;

  playQueue.push(song);
  updateQueueBadgeUI();
  alert(`Queued: "${song.title}"`);
};

function updateQueueBadgeUI() {
  const count = playQueue.length;
  queueCountText.innerText = `${count} Songs in Queue`;
  
  if (count > 0) {
    queueBadge.innerText = count;
    queueBadge.classList.remove('hidden');
  } else {
    queueBadge.classList.add('hidden');
  }
}

function renderQueueList() {
  if (playQueue.length === 0) {
    queueListContainer.innerHTML = `
      <div class="no-songs-state">
        <i data-lucide="list-music"></i>
        <h4>Queue is empty</h4>
        <p>Add songs to the queue from the library by clicking the "+" button next to them.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  queueListContainer.innerHTML = '';
  playQueue.forEach((song, index) => {
    const mainIndex = songs.findIndex(s => s.id === song.id);
    const row = document.createElement('div');
    row.className = 'song-row';
    row.style.gridTemplateColumns = '50px 1fr 1fr 140px 120px 80px';
    
    row.innerHTML = `
      <div class="col-index">${index + 1}</div>
      <div class="col-title song-title-wrapper">
        <span class="song-title">${song.title}</span>
        <span class="song-filename">${song.filename}</span>
      </div>
      <div class="col-artist">${song.artist}</div>
      <div class="col-folder">
        <span class="folder-tag ${getFolderClass(song.folder)}">${song.folder}</span>
      </div>
      <div class="col-size">${formatBytes(song.size)}</div>
      <div class="col-action">
        <button class="delete-row-btn" onclick="removeFromQueue(${index})" title="Remove from queue" style="opacity: 1; transform: scale(1);">
          <i data-lucide="x"></i>
        </button>
        <button class="play-row-btn" onclick="playQueueSong(${index})" aria-label="Play" style="opacity: 1; transform: scale(1);">
          <span class="row-play-icon-wrapper">
            ${mainIndex === currentSongIndex && isPlaying ? getPlayPauseIconHtml(true) : getPlayPauseIconHtml(false)}
          </span>
        </button>
      </div>
    `;
    queueListContainer.appendChild(row);
  });

  if (window.lucide) window.lucide.createIcons();
}

window.removeFromQueue = (queueIndex) => {
  if (queueIndex >= 0 && queueIndex < playQueue.length) {
    playQueue.splice(queueIndex, 1);
    updateQueueBadgeUI();
    renderQueueList();
  }
};

window.playQueueSong = (queueIndex) => {
  if (queueIndex >= 0 && queueIndex < playQueue.length) {
    const song = playQueue[queueIndex];
    playQueue.splice(queueIndex, 1);
    updateQueueBadgeUI();
    
    const mainIdx = songs.findIndex(s => s.id === song.id);
    if (mainIdx !== -1) {
      playSong(mainIdx);
    }
    renderQueueList();
  }
};

clearQueueBtn.addEventListener('click', () => {
  playQueue = [];
  updateQueueBadgeUI();
  renderQueueList();
});

// ----------------------------------------------------
// 8. Downloader Client-side Scraper & API Logic
// ----------------------------------------------------
dlSearchBtn.addEventListener('click', triggerOnlineSearch);

dlSongName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') triggerOnlineSearch();
});
dlLanguage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') triggerOnlineSearch();
});

async function triggerOnlineSearch() {
  const songName = dlSongName.value.trim();
  const language = dlLanguage.value.trim();

  if (!songName) {
    alert('Please enter a song name or lyrics to search.');
    return;
  }

  downloaderResults.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <p>Crawling search engines and download portals...</p>
    </div>
  `;

  try {
    let results = [];
    if (isElectron) {
      results = await window.kiwiAPI.searchOnline(songName, language);
    } else {
      results = await clientSearchOnline(songName, language);
    }
    renderSearchResults(results);
  } catch (err) {
    console.error('Online search failed:', err);
    downloaderResults.innerHTML = `
      <div class="no-results-state">
        <i data-lucide="alert-triangle" style="color: #f35588"></i>
        <h4>Crawling search failed</h4>
        <p>Ensure you are connected to the internet and try again.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
}

function renderSearchResults(results) {
  if (results.length === 0) {
    downloaderResults.innerHTML = `
      <div class="no-results-state">
        <i data-lucide="info"></i>
        <h4>No matching download links found</h4>
        <p>Try refining the song title spelling or specifying the language differently.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  downloaderResults.innerHTML = '';
  results.forEach((item) => {
    const cleanId = getSafeElementId(item.url);

    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <div class="result-meta">
        <span class="result-title">${item.title}</span>
        <span class="result-url" title="${item.url}">${item.url}</span>
      </div>
      <div class="result-source">
        <span class="source-badge">${item.source}</span>
      </div>
      <div class="dl-action-container" id="action-container-${cleanId}">
        <button class="play-preview-btn" onclick="playOnlinePreview('${item.url.replace(/'/g, "\\'")}', '${item.title.replace(/'/g, "\\'")}', '${item.source.replace(/'/g, "\\'")}')" title="Play online preview">
          <i data-lucide="play-circle"></i>
        </button>
        <button class="download-row-btn" onclick="startDownload('${item.url.replace(/'/g, "\\'")}', '${item.filename.replace(/'/g, "\\'")}', '${cleanId}')">
          <i data-lucide="download"></i>
          <span>Download</span>
        </button>
      </div>
    `;
    downloaderResults.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
}

window.playOnlinePreview = async (url, title, source) => {
  audio.pause();
  let streamUrl = url;

  if (url.includes('youtube.com/') || url.includes('youtu.be/')) {
    playerTitle.innerText = 'Extracting stream (Cobalt)...';
    playerArtist.innerText = title;
    try {
      if (isElectron) {
        streamUrl = await window.kiwiAPI.getYoutubeStream(url);
      } else {
        streamUrl = await getCobaltAudioStream(url);
      }
    } catch (err) {
      console.error('Failed to extract stream:', err);
      alert('Unable to extract audio stream for this YouTube link. Try downloading it instead.');
      updatePlayerUI();
      return;
    }
  }

  audio.src = getBypassedUrl(streamUrl);
  audio.load();

  playerTitle.innerText = title;
  playerArtist.innerText = `Online Stream (${source})`;
  playingArtIcon.setAttribute('data-lucide', 'globe');

  currentSongIndex = -1;
  updateSongRowStates();

  audio.play()
    .then(() => {
      isPlaying = true;
      updatePlayerUI();
    })
    .catch(err => {
      console.error('Failed to stream online audio preview:', err);
      alert('Unable to stream this audio. Try downloading it instead.');
    });
};

window.startDownload = async (url, filename, cleanId) => {
  const container = document.getElementById(`action-container-${cleanId}`);
  if (!container) return;

  container.innerHTML = `
    <div class="progress-container">
      <div class="progress-text-row">
        <span>Downloading...</span>
        <span class="progress-pct" id="pct-${cleanId}">0%</span>
      </div>
      <div class="progress-bar-outer">
        <div class="progress-bar-inner" id="bar-${cleanId}" style="width: 0%"></div>
      </div>
    </div>
  `;

  try {
    if (isElectron) {
      await window.kiwiAPI.downloadSong(url, filename);
      container.innerHTML = `
        <span class="download-success-badge">
          <i data-lucide="check-circle-2"></i>
          <span>Saved!</span>
        </span>
      `;
    } else {
      // Standalone/Mobile Blob Downloader
      let downloadUrl = url;
      if (url.includes('youtube.com/') || url.includes('youtu.be/')) {
        downloadUrl = await getCobaltAudioStream(url);
      }
      
      const pctEl = document.getElementById(`pct-${cleanId}`);
      const barEl = document.getElementById(`bar-${cleanId}`);
      if (pctEl && barEl) {
        pctEl.innerText = '50%';
        barEl.style.width = '50%';
      }

      const res = await fetch(getBypassedUrl(downloadUrl));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      
      if (pctEl && barEl) {
        pctEl.innerText = '90%';
        barEl.style.width = '90%';
      }

      const transaction = db.transaction(['songs'], 'readwrite');
      const store = transaction.objectStore('songs');
      const metadata = clientCleanSongMetadata(filename);
      const category = clientClassifyAudio(filename);
      
      await new Promise((res, rej) => {
        const req = store.add({
          title: metadata.title,
          artist: metadata.artist,
          filename: filename,
          size: blob.size,
          folder: 'Downloads',
          category: category,
          mtime: Date.now(),
          blob: blob
        });
        req.onsuccess = () => res();
        req.onerror = (err) => rej(err);
      });

      container.innerHTML = `
        <span class="download-success-badge">
          <i data-lucide="check-circle-2"></i>
          <span>Saved Offline!</span>
        </span>
      `;
    }
    
    if (window.lucide) window.lucide.createIcons();
    loadSongs();
  } catch (err) {
    console.error('Download failed:', err);
    container.innerHTML = `
      <button class="download-row-btn" style="border-color: rgba(243, 85, 136, 0.4); color: #f35588;" onclick="startDownload('${url.replace(/'/g, "\\'")}', '${filename.replace(/'/g, "\\'")}', '${cleanId}')">
        <i data-lucide="alert-circle"></i>
        <span>Retry</span>
      </button>
    `;
    if (window.lucide) window.lucide.createIcons();
  }
};

// ----------------------------------------------------
// 9. Mobile/Web Client Helper Utilities
// ----------------------------------------------------
async function clientFetchTextUrl(url) {
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // If in Capacitor, use native CapacitorHttp plugin explicitly to guarantee CORS bypass & UA spoofing
  if (isCapacitor && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
    try {
      const options = {
        url: url,
        method: 'GET',
        headers: {
          'User-Agent': desktopUA
        }
      };
      const response = await window.Capacitor.Plugins.CapacitorHttp.get(options);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.data;
    } catch (e) {
      console.error('CapacitorHttp native fetch failed, falling back to fetch:', e);
    }
  }

  // Fallback to standard fetch
  const response = await fetch(getBypassedUrl(url), {
    headers: {
      'User-Agent': desktopUA
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function getCobaltAudioStream(url) {
  const postData = {
    url: url,
    audioOnly: true,
    aFormat: 'mp3'
  };

  // If in Capacitor, use native CapacitorHttp plugin explicitly
  if (isCapacitor && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp) {
    try {
      const response = await window.Capacitor.Plugins.CapacitorHttp.post({
        url: 'https://api.cobalt.tools/',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        data: postData
      });
      const json = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
      if (json.status === 'redirect' || json.status === 'tunnel') {
        return json.url;
      }
      throw new Error(json.text || 'Cobalt extraction failed');
    } catch (e) {
      console.error('CapacitorHttp native post failed, falling back to fetch:', e);
    }
  }

  // Fallback to standard fetch
  const response = await fetch(getBypassedUrl('https://api.cobalt.tools/'), {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(postData)
  });
  if (!response.ok) throw new Error(`Cobalt HTTP ${response.status}`);
  const json = await response.json();
  if (json.status === 'redirect' || json.status === 'tunnel') {
    return json.url;
  }
  throw new Error(json.text || 'Cobalt extraction failed');
}

function clientCleanSongMetadata(filename) {
  let name = filename.replace(/\.[^/.]+$/, ""); // strip extension

  // Remove common website tags / quality tags / metadata bloat
  name = name
    .replace(/\[isongs\.info\]/gi, '')
    .replace(/\[djpunjab\S*\]/gi, '')
    .replace(/djpunjab\S*/gi, '')
    .replace(/\(pagalworld\S*\)/gi, '')
    .replace(/pagalworld\S*/gi, '')
    .replace(/\(mr-jatt\S*\)/gi, '')
    .replace(/mr-jatt\S*/gi, '')
    .replace(/\[mr-jatt\S*\]/gi, '')
    .replace(/\[sensongsmp3\S*\]/gi, '')
    .replace(/sensongsmp3\S*/gi, '')
    .replace(/_compressed/gi, '')
    .replace(/^\(Audio\)\s*/i, '')
    .replace(/^\d+\s*-\s*/, '')
    .replace(/^\d+\s+/, '')
    .replace(/\b(128kbps|320kbps|64kbps|kbps)\b/gi, '')
    .replace(/\b(mp3|m4a|wav|ogg|flac|download|song|songs|video|lyrics|official|audio)\b/gi, '')
    .replace(/[\(\)\[\]]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let title = name;
  let artist = 'Local Audio';

  if (name.includes('-')) {
    const parts = name.split('-');
    if (parts.length >= 2) {
      title = parts[0].trim();
      artist = parts.slice(1).join('-').trim();
    }
  }

  const capitalize = (str) => {
    return str
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ')
      .trim();
  };

  title = capitalize(title) || 'Unknown Title';
  artist = capitalize(artist) || 'Local Artist';

  return { title, artist };
}

function clientClassifyAudio(filename) {
  const lower = filename.toLowerCase();
  const spokenKeywords = [
    'meeting', 'zoom', 'call', 'lecture', 'recording', 'voice', 
    'speech', 'interview', 'audio note', 'whatsapp', 'whatsapp video', 
    'whatsapp audio', 'lesson', 'study', 'podcast', 'audiobook', 
    'memo', 'narration', 'spoken', 'talk', 'conversation', 'average', 
    'proc', 'log', 'text', 'doc', 'session', 'expt', 'lab', 'vlog'
  ];

  const hasSpokenKeyword = spokenKeywords.some(keyword => lower.includes(keyword));
  const isZoomFormat = lower.startsWith('(audio) video') || lower.startsWith('(audio) audio');
  const isNumericOrStamp = /^(video|audio|voice|rec|meeting)?[\d_\-\s]+$/i.test(lower.replace(/\.[^/.]+$/, "")) ||
                           /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(lower.replace(/\.[^/.]+$/, "")) ||
                           /^\d+$/i.test(lower.replace(/\.[^/.]+$/, ""));

  if (hasSpokenKeyword || isZoomFormat || isNumericOrStamp) {
    return 'speech';
  }
  return 'music';
}

// ----------------------------------------------------
// 10. Download Progress IPC Listeners
// ----------------------------------------------------
if (window.kiwiAPI && window.kiwiAPI.onDownloadProgress) {
  window.kiwiAPI.onDownloadProgress((data) => {
    const cleanId = getSafeElementId(data.url);
    const percentEl = document.getElementById(`pct-${cleanId}`);
    const barEl = document.getElementById(`bar-${cleanId}`);

    if (percentEl && barEl) {
      percentEl.innerText = `${data.percent}%`;
      barEl.style.width = `${data.percent}%`;
    }
  });
}

// ----------------------------------------------------
// 11. Background Hotkey Listener Integration
// ----------------------------------------------------
if (window.kiwiAPI && window.kiwiAPI.onGlobalMediaCmd) {
  window.kiwiAPI.onGlobalMediaCmd((command) => {
    console.log('Received background system hotkey command:', command);
    if (command === 'toggle') {
      togglePlay();
    } else if (command === 'next') {
      playNext();
    } else if (command === 'prev') {
      playPrevious();
    }
  });
}

// ----------------------------------------------------
// 12. App Keyboard Listeners
// ----------------------------------------------------
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    if (!libraryView.classList.contains('hidden')) {
      searchInput.focus();
      searchInput.select();
    } else {
      dlSongName.focus();
      dlSongName.select();
    }
  }

  if (e.code === 'Space') {
    if (document.activeElement === searchInput || document.activeElement === dlSongName || document.activeElement === dlLanguage) return;
    e.preventDefault();
    togglePlay();
  }
});

// Load playlist initially (for Electron desktop, db load calls this on success for Web/Mobile)
if (isElectron) {
  loadSongs();
}
