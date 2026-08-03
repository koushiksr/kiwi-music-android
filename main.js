// Disable SSL/TLS certificate rejection to prevent corporate proxies, firewall filters, and SSL antiviruses from blocking downloads and searches
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const urlModule = require('url');
const { spawn, exec } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 850,
    minHeight: 620,
    title: 'kiwi Music',
    backgroundColor: '#0a0c14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // Disable webSecurity to play local files directly using native file:// protocol (prevents main thread IPC lockups)
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Fetch helper (handles redirects and User-Agents)
function fetchTextUrl(url) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new urlModule.URL(url);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${url}`));
    }

    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 5000 // Fast 5 second timeout to bypass slow sites
    };

    const protocolHandler = url.startsWith('https') ? https : http;

    protocolHandler.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new urlModule.URL(redirectUrl, url).toString();
        }
        return fetchTextUrl(redirectUrl).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP Error ${res.statusCode}`));
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject)
      .on('timeout', () => reject(new Error('Timeout')));
  });
}

// Fetch helper for DuckDuckGo Lite (POST request, resilient to blocks and captchas)
function fetchDdgLiteText(query) {
  return new Promise((resolve, reject) => {
    const url = 'https://lite.duckduckgo.com/lite/';
    const postData = `q=${encodeURIComponent(query)}`;
    let parsedUrl;
    try {
      parsedUrl = new urlModule.URL(url);
    } catch (e) {
      return reject(e);
    }

    const options = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`DDG Lite HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DDG Lite Timeout'));
    });

    req.write(postData);
    req.end();
  });
}

app.whenReady().then(() => {
  createWindow();

  try {
    globalShortcut.register('MediaPlayPause', () => {
      if (mainWindow) mainWindow.webContents.send('global-media-cmd', 'toggle');
    });

    globalShortcut.register('MediaNextTrack', () => {
      if (mainWindow) mainWindow.webContents.send('global-media-cmd', 'next');
    });

    globalShortcut.register('MediaPreviousTrack', () => {
      if (mainWindow) mainWindow.webContents.send('global-media-cmd', 'prev');
    });
  } catch (err) {
    console.error('Failed to register global shortcuts:', err);
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean song metadata (names/titles) from filenames and online titles
function cleanSongMetadata(filename) {
  const ext = path.extname(filename);
  let name = path.basename(filename, ext);

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
    .replace(/^\d+\s*-\s*/, '') // starting track numbers
    .replace(/^\d+\s+/, '')      // starting numbers
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

  // Capitalize Title and Artist nicely
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

// Classification Helper
function classifyAudio(filename) {
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

// IPC Handler to recursively scan multiple standard folders
ipcMain.handle('scan-songs', async () => {
  const SUPPORTED_EXTENSIONS = ['.mp3', '.m4a', '.wav', '.ogg', '.flac'];
  const USER_ROOT = os.homedir();
  
  const SCAN_TARGETS = [
    { path: path.join(USER_ROOT, 'Downloads'), label: 'Downloads' },
    { path: path.join(USER_ROOT, 'Music'), label: 'Music' },
    { path: path.join(USER_ROOT, 'Desktop'), label: 'Desktop' },
    { path: path.join(USER_ROOT, 'Documents'), label: 'Documents' },
    { path: path.join(USER_ROOT, 'Videos'), label: 'Videos' }
  ];

  const IGNORE_DIRS = [
    'node_modules', '.git', '.venv', 'appdata', 'cookies', 
    'history', 'temp', 'cache', 'system32', 'windows', 
    'program files', 'program files (x86)', 'local settings',
    'microsoft', 'chrome', 'edge', 'package-lock.json', '.agents', 'dist'
  ];

  const songs = [];

  function scanDir(dirPath, label, depth = 0) {
    if (depth > 2) return;
    try {
      if (!fs.existsSync(dirPath)) return;
      const stats = fs.statSync(dirPath);
      if (!stats.isDirectory()) return;

      const items = fs.readdirSync(dirPath);

      items.forEach(item => {
        const fullPath = path.join(dirPath, item);
        const lowerItem = item.toLowerCase();

        try {
          const itemStats = fs.statSync(fullPath);
          if (itemStats.isDirectory()) {
            const shouldIgnore = IGNORE_DIRS.some(ignored => lowerItem.includes(ignored));
            if (!shouldIgnore) {
              scanDir(fullPath, label, depth + 1);
            }
          } else if (itemStats.isFile()) {
            const ext = path.extname(item).toLowerCase();
            if (SUPPORTED_EXTENSIONS.includes(ext)) {
              const metadata = cleanSongMetadata(item);
              const title = metadata.title;
              const artist = metadata.artist;

              const category = classifyAudio(item);

              songs.push({
                id: Buffer.from(fullPath).toString('base64url'),
                title: title || 'Unknown Title',
                artist: artist || 'Local Artist',
                filename: item,
                path: fullPath,
                folder: label,
                category: category,
                size: itemStats.size,
                mtime: itemStats.mtime.getTime()
              });
            }
          }
        } catch (e) {}
      });
    } catch (err) {}
  }

  SCAN_TARGETS.forEach(target => {
    scanDir(target.path, target.label);
  });

  songs.sort((a, b) => b.mtime - a.mtime);
  return songs;
});

// Search Archive.org directly (returns verified safe, clean direct download audio streams)
async function searchArchiveOrg(songName) {
  let cleanSongQuery = songName.toLowerCase()
    .replace(/\b(telugu|hindi|punjabi|kannada|malayalam|tamil|english|mp3|download|song|songs|lyrics)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanSongQuery) {
    cleanSongQuery = songName;
  }

  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(cleanSongQuery)}+AND+mediatype:audio&fl[]=identifier,title,creator&sort[]=downloads+desc&output=json`;
  
  try {
    const response = await fetchTextUrl(url);
    const json = JSON.parse(response);
    const docs = json.response.docs || [];
    const results = [];

    // Crawl top 4 items for metadata details
    for (const doc of docs.slice(0, 4)) {
      try {
        const detailsUrl = `https://archive.org/metadata/${doc.identifier}`;
        const detailsResponse = await fetchTextUrl(detailsUrl);
        const detailsJson = JSON.parse(detailsResponse);
        const files = detailsJson.files || [];

        files.forEach(f => {
          if (f.name.toLowerCase().endsWith('.mp3')) {
            const directUrl = `https://archive.org/download/${doc.identifier}/${f.name}`;
            
            let displayTitle = doc.title || f.name.replace(/\.mp3$/i, '');
            displayTitle = displayTitle.replace(/_compressed/gi, '').replace(/_/g, ' ').trim();
            
            results.push({
              title: displayTitle,
              url: directUrl,
              source: 'Archive.org (Safe & Clean)',
              filename: f.name
            });
          }
        });
      } catch (e) {}
    }
    return results;
  } catch (err) {
    console.error('Archive.org query failed:', err.message);
    return [];
  }
}

// Search YouTube videos via Yahoo Search (scrapes search results, resolving titles and video IDs)
async function searchYoutubeLinks(songName, language) {
  const query = `${songName} ${language} site:youtube.com`;
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  try {
    const html = await fetchTextUrl(url);
    const hrefRegex = /href="([^"]*r\.search\.yahoo\.com[^"]*RU=([^"]+))"/gi;
    
    const results = [];
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      const fullHref = match[1];
      let actualUrl = '';
      try {
        const parts = fullHref.split('RU=');
        if (parts[1]) {
          actualUrl = decodeURIComponent(parts[1].split('/RK=')[0]);
        }
      } catch (e) {
        continue;
      }
      
      if (actualUrl.includes('youtube.com/watch') || actualUrl.includes('youtu.be/')) {
        // Find the next h3 tag starting from the href match index
        const startIndex = match.index;
        const block = html.substring(startIndex, startIndex + 1500);
        
        const titleRegex = /<h3[^>]*>([\s\S]*?)<\/h3>/i;
        const titleMatch = block.match(titleRegex);
        
        let title = songName;
        if (titleMatch) {
          let rawTitle = titleMatch[1];
          title = rawTitle.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
        }
        
        // Clean up common YouTube metadata bloat
        title = title.replace(/\b(official video|official audio|lyrics video|lyrical|hd|4k|mp3|youtube)\b/gi, '')
                     .replace(/[\[\]\(\)-]/g, ' ')
                     .replace(/\s+/g, ' ')
                     .trim();
        
        if (!results.some(r => r.url === actualUrl)) {
          let cleanName = title.replace(/[\\/:*?"<>|]/g, '_') + '.m4a';
          results.push({
            title: title || songName,
            url: actualUrl,
            source: 'YouTube (Audio Mirror)',
            filename: cleanName
          });
        }
      }
    }
    return results.slice(0, 10);
  } catch (err) {
    console.error('Yahoo YouTube search failed:', err.message);
    return [];
  }
}

// Scrape search result engines (Yahoo P1/P2/P3 in parallel)
async function crawlWebSearch(songName, language) {
  const searchQuery = `${songName} ${language} mp3 download`.trim();
  const yahooUrl1 = `https://search.yahoo.com/search?p=${encodeURIComponent(searchQuery)}`;
  const yahooUrl2 = `https://search.yahoo.com/search?p=${encodeURIComponent(searchQuery)}&b=11`;
  const yahooUrl3 = `https://search.yahoo.com/search?p=${encodeURIComponent(searchQuery)}&b=21`;
  
  const pagesHtml = await Promise.all([
    fetchTextUrl(yahooUrl1).catch(() => ''),
    fetchTextUrl(yahooUrl2).catch(() => ''),
    fetchTextUrl(yahooUrl3).catch(() => '')
  ]);

  const links = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  
  pagesHtml.forEach((searchHtml) => {
    if (!searchHtml) return;
    let match;
    
    // Parse Yahoo redirect links
    while ((match = hrefRegex.exec(searchHtml)) !== null) {
      const url = match[1];
      if (url.includes('r.search.yahoo.com') && url.includes('RU=')) {
        try {
          const parts = url.split('RU=');
          if (parts[1]) {
            const actualUrl = decodeURIComponent(parts[1].split('/RK=')[0]);
            const lowerActual = actualUrl.toLowerCase();
            if (!lowerActual.includes('yahoo.com') && !lowerActual.includes('google.com')) {
              links.push(actualUrl);
            }
          }
        } catch (e) {}
      }
    }
  });

  const EXCLUDED_DOMAINS = [
    'yahoo.com', 'google.com', 'wikipedia.org', 'facebook.com', 
    'twitter.com', 'instagram.com', 'youtube.com', 'soundcloud.com', 
    'spotify.com', 'gaana.com', 'jiosaavn.com', 'wynk.in', 'saregama.com',
    'pinterest.com', 'imdb.com', 'amazon.com', 'apple.com', 'music.apple.com'
  ];

  const uniqueResultPages = [...new Set(links)]
    .filter(r => !EXCLUDED_DOMAINS.some(domain => r.toLowerCase().includes(domain)))
    .slice(0, 10);

  const audioResults = [];

  function parseAudioHrefs(html, pageUrl, domain) {
    const pageResults = [];
    const foundUrls = new Set();

    // 1. Text-based universal regex: Grabs any string matching http...mp3 or http...m4a anywhere in html
    const universalRegex = /(https?:\/\/[^\s"'`<>]+?\.(?:mp3|m4a|wav|ogg)(?:\?[^\s"'`<>]+)?)/gi;
    let match;
    while ((match = universalRegex.exec(html)) !== null) {
      foundUrls.add(match[1]);
    }

    // 2. Fallback matching on html relative href tags
    const mp3Regex = /href=["']([^"']+\.mp3[^"']*)["']/gi;
    while ((match = mp3Regex.exec(html)) !== null) {
      foundUrls.add(match[1]);
    }

    // 3. Base64 encoded redirect parameters
    const base64Regex = /link=([a-zA-Z0-9+/=]{12,})/gi;
    while ((match = base64Regex.exec(html)) !== null) {
      try {
        const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
        if (decoded.startsWith('http') && decoded.toLowerCase().includes('.mp3')) {
          foundUrls.add(decoded);
        }
      } catch (e) {}
    }

    foundUrls.forEach(audioUrl => {
      let absoluteUrl = audioUrl;
      if (!audioUrl.startsWith('http')) {
        try {
          absoluteUrl = new urlModule.URL(audioUrl, pageUrl).toString();
        } catch (e) {
          return;
        }
      }

      const lowerUrl = absoluteUrl.toLowerCase();
      if (lowerUrl.includes('sample') || lowerUrl.includes('promo')) return;

      const urlPathname = urlModule.parse(absoluteUrl).pathname || '';
      let filename = path.basename(urlPathname) || 'song.mp3';
      
      filename = filename.split('?')[0];
      filename = filename.replace(/[\\/:*?"<>|]/g, '_');
      if (!filename.toLowerCase().endsWith('.mp3')) {
        filename += '.mp3';
      }
      
      const cleanMeta = cleanSongMetadata(filename);
      let title = cleanMeta.title;
      
      pageResults.push({
        title: title || songName,
        url: absoluteUrl,
        source: domain,
        filename: filename
      });
    });

    return pageResults;
  }

  for (const pageUrl of uniqueResultPages) {
    try {
      console.log(`Crawling: ${pageUrl}`);
      const pageHtml = await fetchTextUrl(pageUrl);
      const domain = new urlModule.URL(pageUrl).hostname;

      const direct = parseAudioHrefs(pageHtml, pageUrl, domain);
      if (direct.length > 0) {
        audioResults.push(...direct);
      }

      // Crawl subpages
      const subpageLinks = new Set();
      const aHrefRegex = /href=["']([^"']+)["']/gi;
      const subpageKeywords = ['/download', 'download-', '/get/', 'file/', 'download-file', 'mirror', 'track/'];
      
      let subMatch;
      while ((subMatch = aHrefRegex.exec(pageHtml)) !== null) {
        const l = subMatch[1].toLowerCase();
        if (subpageKeywords.some(keyword => l.includes(keyword)) && !l.includes('.mp3') && !l.includes('.zip')) {
          subpageLinks.add(subMatch[1]);
        }
      }

      const subpagesToFetch = [...subpageLinks].slice(0, 3);
      for (const subpage of subpagesToFetch) {
        let absoluteSubpage = subpage;
        if (!subpage.startsWith('http')) {
          try {
            absoluteSubpage = new urlModule.URL(subpage, pageUrl).toString();
          } catch (e) {
            continue;
          }
        }
        try {
          const subpageHtml = await fetchTextUrl(absoluteSubpage);
          const subpageAudio = parseAudioHrefs(subpageHtml, absoluteSubpage, domain);
          audioResults.push(...subpageAudio);
        } catch (e) {}
      }
    } catch (e) {}
  }

  return audioResults;
}

// IPC Handler: Online search with parallel Archive.org + YouTube + Scraper aggregation
ipcMain.handle('search-online', async (event, { songName, language }) => {
  console.log(`Universal aggregate search: "${songName}" (${language})`);
  
  try {
    const archiveResultsPromise = searchArchiveOrg(songName).catch(() => []);
    const youtubeResultsPromise = searchYoutubeLinks(songName, language).catch(() => []);
    const webResultsPromise = crawlWebSearch(songName, language).catch(() => []);

    const [archiveResults, youtubeResults, webResults] = await Promise.all([
      archiveResultsPromise,
      youtubeResultsPromise,
      webResultsPromise
    ]);

    const merged = [];
    const seen = new Set();
    
    // 1. Prioritize safe & clean Archive.org links first
    archiveResults.forEach(item => {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    });

    // 2. Append YouTube matches (100% search coverage fallback)
    youtubeResults.forEach(item => {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    });

    // 3. Append crawled mirror sites
    webResults.forEach(item => {
      if (!seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
      }
    });

    console.log(`Aggregation complete. Found ${merged.length} downloadable files.`);
    return merged.slice(0, 25); // Limit to top 25 results

  } catch (err) {
    console.error('Aggregate search failed:', err);
    return [];
  }
});

// IPC Handler: Run yt-dlp to extract the raw YouTube streaming audio URL for direct playback previews
ipcMain.handle('get-youtube-stream', async (event, { youtubeUrl }) => {
  console.log('Extracting direct stream URL for:', youtubeUrl);
  return new Promise((resolve, reject) => {
    // If running in packaged app, the binary path is relative to app resources
    const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
    
    exec(`"${ytDlpPath}" -g -f ba "${youtubeUrl}"`, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp execution error:', err.message);
        return reject(err);
      }
      resolve(stdout.trim());
    });
  });
});

// Spawn process runner for downloading YouTube audio streams directly via yt-dlp with progress reports
function downloadYoutubeSong(youtubeUrl, destPath, urlForIpc) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
    
    // -f "ba[ext=m4a]/ba": requests standard AAC audio m4a container (extremely high quality, widely compatible)
    const child = spawn(ytDlpPath, [
      '-f', 'ba[ext=m4a]/ba',
      '-o', destPath,
      '--no-part',
      youtubeUrl
    ]);

    child.stdout.on('data', (data) => {
      const line = data.toString();
      const match = line.match(/\[download\]\s+(\d+\.\d+)%/);
      if (match && mainWindow) {
        const percent = Math.round(parseFloat(match[1]));
        mainWindow.webContents.send('download-progress', {
          url: urlForIpc,
          downloaded: 0,
          total: 0,
          percent: percent
        });
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

// IPC Handler: Stream file download
ipcMain.handle('download-song', async (event, { url, filename }) => {
  console.log(`Downloading request: ${url} -> ${filename}`);
  
  let cleanFilename = filename.split('?')[0];
  cleanFilename = cleanFilename.replace(/[\\/:*?"<>|]/g, '_');
  
  // If the destination file was queued from a YouTube link, route it through yt-dlp
  if (url.includes('youtube.com/') || url.includes('youtu.be/')) {
    if (!cleanFilename.toLowerCase().endsWith('.m4a') && !cleanFilename.toLowerCase().endsWith('.mp3')) {
      cleanFilename += '.m4a';
    }
    const destPath = path.join(os.homedir(), 'Downloads', cleanFilename);
    try {
      await downloadYoutubeSong(url, destPath, url);
      return { destPath, filename: cleanFilename };
    } catch (e) {
      console.error('yt-dlp streaming download failed:', e.message);
      throw e;
    }
  }

  // Otherwise, fallback to direct HTTP/HTTPS download stream
  if (!cleanFilename.toLowerCase().endsWith('.mp3')) {
    cleanFilename += '.mp3';
  }
  const destPath = path.join(os.homedir(), 'Downloads', cleanFilename);
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    
    function download(downloadUrl) {
      const parsedUrl = new urlModule.URL(downloadUrl);
      const protocolHandler = downloadUrl.startsWith('https') ? https : http;

      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': parsedUrl.origin || 'https://google.com',
          'Accept': '*/*'
        },
        timeout: 20000
      };

      protocolHandler.get(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http')) {
            redirectUrl = new urlModule.URL(redirectUrl, downloadUrl).toString();
          }
          return download(redirectUrl);
        }

        if (res.statusCode !== 200) {
          fs.unlink(destPath, () => {});
          return reject(new Error(`Server returned HTTP ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'], 10);
        let downloadedBytes = 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          const percent = totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          
          if (mainWindow) {
            mainWindow.webContents.send('download-progress', {
              url,
              downloaded: downloadedBytes,
              total: totalBytes || 0,
              percent: percent
            });
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve({ destPath, filename: cleanFilename });
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    download(url);
  });
});

// IPC Handler: Permanently delete list of files from system storage
ipcMain.handle('delete-songs', async (event, { filePaths }) => {
  console.log('Permanently deleting audio files:', filePaths);
  const deleteSummary = [];
  
  for (const rawPath of filePaths) {
    let filePath = rawPath;
    try {
      if (!fs.existsSync(filePath)) {
        // Try decoding base64url song ID
        try {
          const decoded = Buffer.from(rawPath, 'base64url').toString('utf-8');
          if (fs.existsSync(decoded)) {
            filePath = decoded;
          }
        } catch (e) {}
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deleteSummary.push({ path: filePath, success: true });
      } else {
        deleteSummary.push({ path: rawPath, success: false, error: 'File does not exist' });
      }
    } catch (err) {
      console.error(`Failed to delete file ${filePath}:`, err.message);
      deleteSummary.push({ path: rawPath, success: false, error: err.message });
    }
  }
  return deleteSummary;
});
