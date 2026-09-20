import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:just_audio/just_audio.dart';
import 'package:on_audio_query/on_audio_query.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:provider/provider.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(
    ChangeNotifierProvider(
      create: (_) => KiwiMusicProvider()..init(),
      child: const KiwiMusicApp(),
    ),
  );
}

class KiwiMusicApp extends StatelessWidget {
  const KiwiMusicApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'kiwi Music',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF080A10),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF00F2FE),
          secondary: Color(0xFFF35588),
          surface: Color(0xFF101424),
        ),
        useMaterial3: true,
      ),
      home: const MainHomeScreen(),
    );
  }
}

// ----------------------------------------------------
// Models & Enums
// ----------------------------------------------------
enum RepeatMode { off, all, one }

class LocalTrack {
  final String id;
  final String title;
  final String artist;
  final String album;
  final String uri;
  final String category; // 'music' or 'speech'
  final int size;
  final int duration; // in milliseconds
  final String folder;

  LocalTrack({
    required this.id,
    required this.title,
    required this.artist,
    required this.album,
    required this.uri,
    required this.category,
    required this.size,
    required this.duration,
    required this.folder,
  });
}

class SearchResultItem {
  final String title;
  final String artist;
  final String url;
  final String source; // 'YouTube', 'SoundCloud', 'Archive.org', 'Direct Audio', 'Web Link'
  final String duration;
  final String filename;

  SearchResultItem({
    required this.title,
    this.artist = 'Online Audio',
    required this.url,
    required this.source,
    this.duration = '',
    required this.filename,
  });
}

// Helper function to format duration as mm:ss or hh:mm:ss
String formatDuration(Duration d) {
  if (d.inHours > 0) {
    return '${d.inHours}:${(d.inMinutes % 60).toString().padLeft(2, '0')}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';
  }
  return '${d.inMinutes.toString().padLeft(2, '0')}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';
}

// ----------------------------------------------------
// State Management & Audio Controller
// ----------------------------------------------------
class KiwiMusicProvider extends ChangeNotifier {
  final OnAudioQuery _audioQuery = OnAudioQuery();
  final AudioPlayer _player = AudioPlayer();

  List<LocalTrack> _tracks = [];
  List<LocalTrack> _queue = [];
  String _category = 'music'; // 'music' or 'speech'
  String _searchQuery = '';
  int _currentIndex = -1;

  bool _isPlaying = false;
  Duration _position = Duration.zero;
  Duration _duration = Duration.zero;
  bool _isLoading = false;

  // Playback Modes
  RepeatMode _repeatMode = RepeatMode.all;
  bool _isShuffle = false;

  // Online Downloader state
  List<SearchResultItem> _searchResults = [];
  bool _isSearchingOnline = false;
  final Map<String, double> _downloadProgress = {};
  final Map<String, String> _downloadStatus = {};

  // Getters
  List<LocalTrack> get tracks => _tracks;
  List<LocalTrack> get queue => _queue;
  String get category => _category;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _isPlaying;
  Duration get position => _position;
  Duration get duration => _duration;
  bool get isLoading => _isLoading;
  RepeatMode get repeatMode => _repeatMode;
  bool get isShuffle => _isShuffle;
  List<SearchResultItem> get searchResults => _searchResults;
  bool get isSearchingOnline => _isSearchingOnline;
  Map<String, double> get downloadProgress => _downloadProgress;
  Map<String, String> get downloadStatus => _downloadStatus;

  LocalTrack? get currentTrack =>
      (_currentIndex >= 0 && _currentIndex < _tracks.length)
          ? _tracks[_currentIndex]
          : null;

  void init() {
    _player.playerStateStream.listen((state) {
      _isPlaying = state.playing;
      if (state.processingState == ProcessingState.completed) {
        if (_repeatMode == RepeatMode.one) {
          seek(Duration.zero);
          _player.play();
        } else {
          playNext();
        }
      }
      notifyListeners();
    });

    _player.positionStream.listen((pos) {
      _position = pos;
      notifyListeners();
    });

    _player.durationStream.listen((dur) {
      _duration = dur ?? Duration.zero;
      notifyListeners();
    });

    scanDeviceAudio();
  }

  // Scan Native Android MediaStore with modern Android 13/14 permission handling
  Future<void> scanDeviceAudio() async {
    _isLoading = true;
    notifyListeners();

    try {
      if (Platform.isAndroid) {
        // 1. Android 13+ Notification permission for background controls
        if (await Permission.notification.isDenied) {
          await Permission.notification.request();
        }

        // 2. Android 13+ READ_MEDIA_AUDIO or legacy storage permission
        var audioStatus = await Permission.audio.status;
        if (!audioStatus.isGranted) {
          audioStatus = await Permission.audio.request();
        }

        var storageStatus = await Permission.storage.status;
        if (!storageStatus.isGranted && !audioStatus.isGranted) {
          storageStatus = await Permission.storage.request();
        }

        // OnAudioQuery built-in fallback request
        await _audioQuery.checkAndRequest(retryRequest: true);
      }

      List<SongModel> songs = await _audioQuery.querySongs(
        sortType: SongSortType.TITLE,
        orderType: OrderType.ASC_OR_SMALLER,
        uriType: UriType.EXTERNAL,
        ignoreCase: true,
      );

      List<LocalTrack> temp = [];
      for (var s in songs) {
        // Skip short system sounds / chimes / ringtone snippets under 5 seconds
        if (s.duration != null && s.duration! > 0 && s.duration! < 5000) {
          continue;
        }

        String cleanTitle = cleanMetadata(s.title);
        String cleanArtist = (s.artist == null || s.artist == '<unknown>' || s.artist!.isEmpty)
            ? 'Local Audio'
            : cleanMetadata(s.artist!);
        String albumName = (s.album == null || s.album == '<unknown>' || s.album!.isEmpty)
            ? 'Unknown Album'
            : s.album!;
        String category = classifyAudio(s.title);

        temp.add(LocalTrack(
          id: s.id.toString(),
          title: cleanTitle.isEmpty ? s.title : cleanTitle,
          artist: cleanArtist.isEmpty ? 'Local Audio' : cleanArtist,
          album: albumName,
          uri: s.data,
          category: category,
          size: s.size,
          duration: s.duration ?? 0,
          folder: s.displayName.split('.').last,
        ));
      }

      _tracks = temp;
    } catch (e) {
      debugPrint('Scan device audio failed: $e');
    }

    _isLoading = false;
    notifyListeners();
  }

  // Clean metadata titles & artists
  String cleanMetadata(String input) {
    return input
        .replaceAll(RegExp(r'\[isongs\.info\]', caseSensitive: false), '')
        .replaceAll(RegExp(r'\[djpunjab\S*\]', caseSensitive: false), '')
        .replaceAll(RegExp(r'djpunjab\S*', caseSensitive: false), '')
        .replaceAll(RegExp(r'\(pagalworld\S*\)', caseSensitive: false), '')
        .replaceAll(RegExp(r'pagalworld\S*', caseSensitive: false), '')
        .replaceAll(RegExp(r'\[mr-jatt\S*\]', caseSensitive: false), '')
        .replaceAll(RegExp(r'\(mr-jatt\S*\)', caseSensitive: false), '')
        .replaceAll(RegExp(r'\[sensongsmp3\S*\]', caseSensitive: false), '')
        .replaceAll(RegExp(r'_compressed', caseSensitive: false), '')
        .replaceAll(RegExp(r'^\(Audio\)\s*', caseSensitive: false), '')
        .replaceAll(RegExp(r'^\d+\s*-\s*'), '')
        .replaceAll(RegExp(r'\b(128kbps|320kbps|64kbps|kbps)\b', caseSensitive: false), '')
        .replaceAll(RegExp(r'[\(\)\[\]]'), ' ')
        .replaceAll('_', ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
  }

  String classifyAudio(String title) {
    String lower = title.toLowerCase();
    List<String> keywords = [
      'meeting', 'zoom', 'call', 'lecture', 'recording', 'voice', 'speech',
      'interview', 'audio note', 'whatsapp', 'lesson', 'podcast', 'audiobook'
    ];
    for (var k in keywords) {
      if (lower.contains(k)) return 'speech';
    }
    return 'music';
  }

  List<LocalTrack> get filteredTracks {
    List<LocalTrack> catFiltered = _tracks.where((t) => t.category == _category).toList();
    if (_searchQuery.isEmpty) return catFiltered;

    String query = _searchQuery.toLowerCase().trim();
    return catFiltered.where((t) {
      return t.title.toLowerCase().contains(query) ||
             t.artist.toLowerCase().contains(query) ||
             t.album.toLowerCase().contains(query);
    }).toList();
  }

  void setCategory(String cat) {
    _category = cat;
    notifyListeners();
  }

  void setSearchQuery(String q) {
    _searchQuery = q;
    notifyListeners();
  }

  // Playback Operations
  Future<void> playTrack(int index) async {
    if (index < 0 || index >= _tracks.length) return;
    _currentIndex = index;
    var track = _tracks[_currentIndex];

    try {
      await _player.setFilePath(track.uri);
      _player.play();
      _isPlaying = true;
    } catch (e) {
      debugPrint('Playback error: $e');
    }
    notifyListeners();
  }

  // Play track accurately by model reference (avoids filtered list index mismatch bug)
  Future<void> playTrackByModel(LocalTrack track) async {
    int idx = _tracks.indexWhere((t) => t.id == track.id);
    if (idx != -1) {
      await playTrack(idx);
    } else {
      try {
        await _player.setFilePath(track.uri);
        _player.play();
        _isPlaying = true;
        _currentIndex = -1;
        notifyListeners();
      } catch (e) {
        debugPrint('Direct track play error: $e');
      }
    }
  }

  void togglePlay() {
    if (_isPlaying) {
      _player.pause();
    } else {
      if (_currentIndex == -1 && _tracks.isNotEmpty) {
        playTrack(0);
        return;
      }
      _player.play();
    }
    _isPlaying = !_isPlaying;
    notifyListeners();
  }

  void playNext() {
    // 1. Play from queued songs first
    if (_queue.isNotEmpty) {
      var nextTrack = _queue.removeAt(0);
      int idx = _tracks.indexWhere((t) => t.id == nextTrack.id);
      if (idx != -1) {
        playTrack(idx);
        return;
      } else {
        playTrackByModel(nextTrack);
        return;
      }
    }

    if (_tracks.isEmpty) return;

    // 2. Shuffle mode
    if (_isShuffle && _tracks.length > 1) {
      int next = Random().nextInt(_tracks.length);
      while (next == _currentIndex) {
        next = Random().nextInt(_tracks.length);
      }
      playTrack(next);
      return;
    }

    // 3. Normal sequential mode
    int next = _currentIndex + 1;
    if (next >= _tracks.length) {
      if (_repeatMode == RepeatMode.off) {
        _player.stop();
        _isPlaying = false;
        notifyListeners();
        return;
      }
      next = 0;
    }
    playTrack(next);
  }

  void playPrevious() {
    if (_tracks.isEmpty) return;

    if (_position.inSeconds > 3) {
      seek(Duration.zero);
      return;
    }

    int prev = _currentIndex - 1;
    if (prev < 0) prev = _tracks.length - 1;
    playTrack(prev);
  }

  void seek(Duration pos) {
    _player.seek(pos);
  }

  void toggleShuffle() {
    _isShuffle = !_isShuffle;
    notifyListeners();
  }

  void toggleRepeat() {
    if (_repeatMode == RepeatMode.all) {
      _repeatMode = RepeatMode.one;
    } else if (_repeatMode == RepeatMode.one) {
      _repeatMode = RepeatMode.off;
    } else {
      _repeatMode = RepeatMode.all;
    }
    notifyListeners();
  }

  void addToQueue(LocalTrack track) {
    _queue.add(track);
    notifyListeners();
  }

  void removeFromQueue(int index) {
    if (index >= 0 && index < _queue.length) {
      _queue.removeAt(index);
      notifyListeners();
    }
  }

  void clearQueue() {
    _queue.clear();
    notifyListeners();
  }

  // Delete song from device storage
  Future<bool> deleteTrack(LocalTrack track) async {
    try {
      final file = File(track.uri);
      if (await file.exists()) {
        await file.delete();
      }
      _tracks.removeWhere((t) => t.id == track.id);
      _queue.removeWhere((t) => t.id == track.id);
      if (currentTrack?.id == track.id) {
        _player.stop();
        _currentIndex = -1;
      }
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('Delete error: $e');
      return false;
    }
  }

  // Multi-Domain & Universal Search Engine
  Future<void> searchOnline(String queryText, String language, {String domain = 'all'}) async {
    if (queryText.trim().isEmpty) return;

    _isSearchingOnline = true;
    _searchResults = [];
    notifyListeners();

    String q = queryText.trim();

    // 1. DIRECT URL INPUT: If user pasted any link (YouTube, SoundCloud, direct MP3, Instagram, etc.)
    if (q.startsWith('http://') || q.startsWith('https://')) {
      Uri? parsed = Uri.tryParse(q);
      String host = parsed?.host.replaceAll('www.', '') ?? 'Web Link';
      String sourceName = 'Direct Link';
      if (host.contains('youtube') || host.contains('youtu.be')) sourceName = 'YouTube';
      else if (host.contains('soundcloud')) sourceName = 'SoundCloud';
      else if (host.contains('archive.org')) sourceName = 'Archive.org';
      else if (host.contains('instagram')) sourceName = 'Instagram';
      else if (host.contains('tiktok')) sourceName = 'TikTok';

      String baseName = parsed?.pathSegments.isNotEmpty == true
          ? parsed!.pathSegments.last.split('?').first
          : 'downloaded_audio';
      if (baseName.isEmpty) baseName = 'Audio Track';
      baseName = cleanMetadata(baseName);

      _searchResults = [
        SearchResultItem(
          title: baseName.isEmpty ? 'Direct Audio Stream' : baseName,
          artist: host,
          url: q,
          source: sourceName,
          duration: 'Live Link',
          filename: '$baseName.mp3',
        ),
      ];
      _isSearchingOnline = false;
      notifyListeners();
      return;
    }

    List<SearchResultItem> temp = [];

    // 2. Source A: Invidious Public API (High-speed, structured YouTube stream metadata)
    if (domain == 'all' || domain == 'youtube') {
      final invidiousEndpoints = [
        'https://vid.puffyan.us',
        'https://yewtu.be',
        'https://invidious.nerdvpn.de',
        'https://inv.nadeko.net',
      ];

      for (var instance in invidiousEndpoints) {
        try {
          var res = await http.get(
            Uri.parse('$instance/api/v1/search?q=${Uri.encodeComponent('$q $language'.trim())}&type=video'),
            headers: {'Accept': 'application/json'},
          ).timeout(const Duration(seconds: 4));

          if (res.statusCode == 200) {
            var items = jsonDecode(res.body) as List;
            for (var item in items.take(6)) {
              String vId = item['videoId'] ?? '';
              String title = cleanMetadata(item['title'] ?? q);
              String author = item['author'] ?? 'YouTube';
              int lengthSec = item['lengthSeconds'] ?? 0;
              String durStr = lengthSec > 0 ? formatDuration(Duration(seconds: lengthSec)) : '';
              if (vId.isNotEmpty && !temp.any((r) => r.url.contains(vId))) {
                temp.add(SearchResultItem(
                  title: title,
                  artist: author,
                  url: 'https://www.youtube.com/watch?v=$vId',
                  source: 'YouTube',
                  duration: durStr,
                  filename: '$title.mp3',
                ));
              }
            }
            if (temp.isNotEmpty) break;
          }
        } catch (_) {}
      }
    }

    // 3. Source B: DuckDuckGo Lite Multi-Domain Crawler (SoundCloud, Archive.org, Direct MP3s)
    try {
      String siteParam = '';
      if (domain == 'soundcloud') siteParam = 'site:soundcloud.com';
      else if (domain == 'archive') siteParam = 'site:archive.org';
      else if (domain == 'direct') siteParam = 'filetype:mp3';

      String ddgQuery = '$q $language $siteParam'.trim();
      var ddgRes = await http.post(
        Uri.parse('https://lite.duckduckgo.com/lite/'),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'q=${Uri.encodeComponent(ddgQuery)}',
      ).timeout(const Duration(seconds: 5));

      if (ddgRes.statusCode == 200) {
        String html = ddgRes.body;
        RegExp linkRegex = RegExp(r'<a class="result-link" href="([^"]+)">(.*?)<\/a>', dotAll: true);
        var matches = linkRegex.allMatches(html);
        for (var m in matches) {
          String href = m.group(1) ?? '';
          String rawTitle = m.group(2)?.replaceAll(RegExp(r'<[^>]*>'), '') ?? q;
          String cleanTitle = cleanMetadata(rawTitle);
          String src = 'Web Portal';
          if (href.contains('soundcloud.com')) src = 'SoundCloud';
          else if (href.contains('archive.org')) src = 'Archive.org';
          else if (href.contains('youtube.com')) src = 'YouTube';

          if (!temp.any((r) => r.url == href)) {
            temp.add(SearchResultItem(
              title: cleanTitle.isEmpty ? q : cleanTitle,
              artist: src,
              url: href,
              source: src,
              duration: '',
              filename: '$cleanTitle.mp3',
            ));
          }
        }
      }
    } catch (_) {}

    // 4. Source C: Fallback to Yahoo Search
    if (temp.length < 3) {
      try {
        String yahooQuery = '$q $language site:youtube.com'.trim();
        var yahooRes = await http.get(
          Uri.parse('https://search.yahoo.com/search?p=${Uri.encodeComponent(yahooQuery)}'),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
        ).timeout(const Duration(seconds: 5));

        if (yahooRes.statusCode == 200) {
          String html = yahooRes.body;
          RegExp hrefRegex = RegExp(r'href="([^"]*r\.search\.yahoo\.com[^"]*RU=([^"]+))"', caseSensitive: false);
          for (var m in hrefRegex.allMatches(html)) {
            String fullHref = m.group(1) ?? '';
            var parts = fullHref.split('RU=');
            if (parts.length > 1) {
              String actualUrl = Uri.decodeComponent(parts[1].split('/RK=')[0]);
              if (actualUrl.contains('youtube.com/watch') || actualUrl.contains('youtu.be/')) {
                if (!temp.any((r) => r.url == actualUrl)) {
                  String title = cleanMetadata(q);
                  temp.add(SearchResultItem(
                    title: title,
                    artist: 'YouTube Mirror',
                    url: actualUrl,
                    source: 'YouTube',
                    duration: '',
                    filename: '$title.mp3',
                  ));
                }
              }
            }
          }
        }
      } catch (_) {}
    }

    _searchResults = temp;
    _isSearchingOnline = false;
    notifyListeners();
  }

  // Universal Any-Link Downloader with Multi-Tier Fallbacks
  Future<void> downloadSong(SearchResultItem item) async {
    _downloadProgress[item.url] = 0.1;
    _downloadStatus[item.url] = 'Resolving stream...';
    notifyListeners();

    try {
      String? streamUrl;

      // DIRECT AUDIO FILE CHECK:
      String lowerUrl = item.url.toLowerCase();
      if (lowerUrl.endsWith('.mp3') || lowerUrl.endsWith('.m4a') || lowerUrl.endsWith('.wav') || lowerUrl.endsWith('.aac') || lowerUrl.endsWith('.ogg')) {
        streamUrl = item.url;
        _downloadStatus[item.url] = 'Direct stream detected';
      }

      // TIER 1: Multi-Instance Cobalt v10 Resolver (Supports YouTube, SoundCloud, Instagram, TikTok, Reddit, Vimeo, Twitter/X)
      if (streamUrl == null) {
        _downloadStatus[item.url] = 'Querying Cobalt network...';
        final cobaltEndpoints = [
          'https://api.cobalt.tools/',
          'https://co.wuk.sh/api/json',
          'https://cobalt.kwiatekm.tokyo/api/json',
          'https://cobalt.tools/api/json',
          'https://api.cobalt.lol/api/json',
        ];

        for (var endpoint in cobaltEndpoints) {
          try {
            var cobaltRes = await http.post(
              Uri.parse(endpoint),
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
              },
              body: jsonEncode({
                'url': item.url,
                'downloadMode': 'audio',
                'audioFormat': 'mp3',
              }),
            ).timeout(const Duration(seconds: 8));

            if (cobaltRes.statusCode == 200) {
              var json = jsonDecode(cobaltRes.body);
              if (json['url'] != null) {
                streamUrl = json['url'];
                break;
              }
            } else {
              // Try legacy audioOnly payload on same instance
              var legacyRes = await http.post(
                Uri.parse(endpoint),
                headers: {
                  'Accept': 'application/json',
                  'Content-Type': 'application/json',
                },
                body: jsonEncode({
                  'url': item.url,
                  'audioOnly': true,
                  'aFormat': 'mp3',
                }),
              ).timeout(const Duration(seconds: 8));

              if (legacyRes.statusCode == 200) {
                var json = jsonDecode(legacyRes.body);
                if (json['url'] != null) {
                  streamUrl = json['url'];
                  break;
                }
              }
            }
          } catch (_) {}
        }
      }

      // TIER 2: Invidious Audio Stream Resolver (for YouTube links)
      if (streamUrl == null && (item.url.contains('youtube.com') || item.url.contains('youtu.be'))) {
        _downloadStatus[item.url] = 'Resolving via Invidious fallback...';
        String? videoId;
        if (item.url.contains('watch?v=')) {
          videoId = item.url.split('watch?v=').last.split('&').first;
        } else if (item.url.contains('youtu.be/')) {
          videoId = item.url.split('youtu.be/').last.split('?').first;
        }

        if (videoId != null && videoId.isNotEmpty) {
          final invidiousInstances = [
            'https://vid.puffyan.us',
            'https://yewtu.be',
            'https://invidious.nerdvpn.de',
            'https://inv.nadeko.net',
          ];

          for (var instance in invidiousInstances) {
            try {
              var vRes = await http.get(
                Uri.parse('$instance/api/v1/videos/$videoId'),
                headers: {'Accept': 'application/json'},
              ).timeout(const Duration(seconds: 6));

              if (vRes.statusCode == 200) {
                var json = jsonDecode(vRes.body);
                var adaptive = json['adaptiveFormats'] as List?;
                if (adaptive != null) {
                  for (var fmt in adaptive) {
                    String mime = fmt['type'] ?? '';
                    if (mime.startsWith('audio/')) {
                      streamUrl = fmt['url'];
                      break;
                    }
                  }
                }
                if (streamUrl != null) break;
              }
            } catch (_) {}
          }
        }
      }

      // TIER 3: Piped Stream Fallback
      if (streamUrl == null && (item.url.contains('youtube.com') || item.url.contains('youtu.be'))) {
        _downloadStatus[item.url] = 'Resolving via Piped fallback...';
        try {
          String? videoId = item.url.contains('watch?v=')
              ? item.url.split('watch?v=').last.split('&').first
              : item.url.split('youtu.be/').last.split('?').first;
          var pipedRes = await http.get(
            Uri.parse('https://pipedapi.kavin.rocks/streams/$videoId'),
          ).timeout(const Duration(seconds: 6));
          if (pipedRes.statusCode == 200) {
            var json = jsonDecode(pipedRes.body);
            var audioStreams = json['audioStreams'] as List?;
            if (audioStreams != null && audioStreams.isNotEmpty) {
              streamUrl = audioStreams.first['url'];
            }
          }
        } catch (_) {}
      }

      if (streamUrl == null) {
        throw Exception('All download resolvers failed to extract an audio stream.');
      }

      _downloadProgress[item.url] = 0.4;
      _downloadStatus[item.url] = 'Downloading audio bytes...';
      notifyListeners();

      // 2. Target public Android Downloads folder
      String targetDir;
      final publicDownloadDir = Directory('/storage/emulated/0/Download');
      if (publicDownloadDir.existsSync()) {
        targetDir = publicDownloadDir.path;
      } else {
        Directory? extDir = await getExternalStorageDirectory();
        targetDir = extDir?.path ?? (await getApplicationDocumentsDirectory()).path;
      }

      String safeFilename = item.filename.replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
      if (!safeFilename.endsWith('.mp3')) safeFilename += '.mp3';
      String targetPath = '$targetDir/$safeFilename';

      var audioRes = await http.get(Uri.parse(streamUrl)).timeout(const Duration(seconds: 90));
      File file = File(targetPath);
      await file.writeAsBytes(audioRes.bodyBytes);

      _downloadProgress[item.url] = 1.0;
      _downloadStatus[item.url] = 'Saved to /Download!';
      notifyListeners();

      // Rescan library automatically
      scanDeviceAudio();
    } catch (e) {
      debugPrint('Download error: $e');
      _downloadProgress[item.url] = -1.0;
      _downloadStatus[item.url] = 'Download failed: $e';
      notifyListeners();
    }
  }
}

// ----------------------------------------------------
// UI Views
// ----------------------------------------------------
class MainHomeScreen extends StatefulWidget {
  const MainHomeScreen({super.key});

  @override
  State<MainHomeScreen> createState() => _MainHomeScreenState();
}

class _MainHomeScreenState extends State<MainHomeScreen> {
  int _currentTab = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          IndexedStack(
            index: _currentTab,
            children: const [
              LibraryTab(),
              QueueTab(),
              DownloaderTab(),
            ],
          ),
          const Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: PersistentPlayerDrawer(),
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _currentTab,
        onTap: (idx) => setState(() => _currentTab = idx),
        backgroundColor: const Color(0xFF0A0C16),
        selectedItemColor: const Color(0xFF00F2FE),
        unselectedItemColor: Colors.grey,
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.library_music), label: 'Library'),
          BottomNavigationBarItem(icon: Icon(Icons.queue_music), label: 'Queue'),
          BottomNavigationBarItem(icon: Icon(Icons.cloud_download), label: 'Downloader'),
        ],
      ),
    );
  }
}

// Library Tab
class LibraryTab extends StatelessWidget {
  const LibraryTab({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<KiwiMusicProvider>(context);

    return SafeArea(
      child: Column(
        children: [
          // Header Bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 12.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'kiwi Music',
                      style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    Text(
                      '${provider.filteredTracks.length} Audio Files',
                      style: const TextStyle(fontSize: 12, color: Colors.grey),
                    ),
                  ],
                ),
                ElevatedButton.icon(
                  onPressed: () => provider.scanDeviceAudio(),
                  icon: const Icon(Icons.sync, size: 16),
                  label: const Text('Rescan Folders'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF101424),
                    foregroundColor: const Color(0xFF00F2FE),
                  ),
                ),
              ],
            ),
          ),

          // Category Switcher
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0),
            child: Row(
              children: [
                ChoiceChip(
                  label: const Text('Music Audio'),
                  selected: provider.category == 'music',
                  selectedColor: const Color(0xFF00F2FE).withOpacity(0.2),
                  onSelected: (_) => provider.setCategory('music'),
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text('Spoken Audio'),
                  selected: provider.category == 'speech',
                  selectedColor: const Color(0xFFF35588).withOpacity(0.2),
                  onSelected: (_) => provider.setCategory('speech'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),

          // Search Input
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16.0),
            child: TextField(
              onChanged: (val) => provider.setSearchQuery(val),
              decoration: InputDecoration(
                hintText: 'Search songs, artists, or albums...',
                prefixIcon: const Icon(Icons.search, color: Colors.grey),
                filled: true,
                fillColor: const Color(0xFF101424),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
              ),
            ),
          ),
          const SizedBox(height: 8),

          // Tracks List View
          Expanded(
            child: provider.isLoading
                ? const Center(child: CircularProgressIndicator())
                : provider.filteredTracks.isEmpty
                    ? Center(
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(Icons.music_off, size: 48, color: Colors.grey),
                            const SizedBox(height: 8),
                            const Text('No audio files found.', style: TextStyle(color: Colors.grey)),
                            const SizedBox(height: 8),
                            TextButton.icon(
                              onPressed: () => provider.scanDeviceAudio(),
                              icon: const Icon(Icons.refresh, color: Color(0xFF00F2FE)),
                              label: const Text('Scan Device Storage', style: TextStyle(color: Color(0xFF00F2FE))),
                            ),
                          ],
                        ),
                      )
                    : ListView.builder(
                        padding: const EdgeInsets.only(bottom: 90),
                        itemCount: provider.filteredTracks.length,
                        itemBuilder: (ctx, i) {
                          var track = provider.filteredTracks[i];
                          bool isCurrent = provider.currentTrack?.id == track.id;
                          int trackIdInt = int.tryParse(track.id) ?? 0;

                          return ListTile(
                            leading: ClipRRect(
                              borderRadius: BorderRadius.circular(8),
                              child: SizedBox(
                                width: 48,
                                height: 48,
                                child: QueryArtworkWidget(
                                  id: trackIdInt,
                                  type: ArtworkType.AUDIO,
                                  artworkBorder: BorderRadius.circular(8),
                                  nullArtworkWidget: Container(
                                    color: const Color(0xFF101424),
                                    child: Icon(
                                      isCurrent && provider.isPlaying ? Icons.equalizer : Icons.music_note,
                                      color: isCurrent ? const Color(0xFF00F2FE) : Colors.grey,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            title: Text(
                              track.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: isCurrent ? const Color(0xFF00F2FE) : Colors.white,
                                fontWeight: isCurrent ? FontWeight.bold : FontWeight.normal,
                              ),
                            ),
                            subtitle: Text(
                              '${track.artist} • ${track.duration > 0 ? formatDuration(Duration(milliseconds: track.duration)) : track.folder}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: Colors.grey),
                            ),
                            trailing: PopupMenuButton<String>(
                              icon: const Icon(Icons.more_vert, color: Colors.grey),
                              onSelected: (val) async {
                                if (val == 'queue') {
                                  provider.addToQueue(track);
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(content: Text('Added "${track.title}" to queue')),
                                  );
                                } else if (val == 'delete') {
                                  bool ok = await provider.deleteTrack(track);
                                  if (context.mounted) {
                                    ScaffoldMessenger.of(context).showSnackBar(
                                      SnackBar(
                                        content: Text(ok ? 'File deleted successfully' : 'Could not delete file'),
                                      ),
                                    );
                                  }
                                }
                              },
                              itemBuilder: (ctx) => [
                                const PopupMenuItem(
                                  value: 'queue',
                                  child: Row(
                                    children: [
                                      Icon(Icons.queue_music, size: 18),
                                      SizedBox(width: 8),
                                      Text('Add to Queue'),
                                    ],
                                  ),
                                ),
                                const PopupMenuItem(
                                  value: 'delete',
                                  child: Row(
                                    children: [
                                      Icon(Icons.delete_outline, size: 18, color: Colors.redAccent),
                                      SizedBox(width: 8),
                                      Text('Delete from Device', style: TextStyle(color: Colors.redAccent)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                            onTap: () => provider.playTrackByModel(track),
                          );
                        },
                      ),
          ),
        ],
      ),
    );
  }
}

// Queue Tab
class QueueTab extends StatelessWidget {
  const QueueTab({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<KiwiMusicProvider>(context);

    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  '${provider.queue.length} Songs in Queue',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                if (provider.queue.isNotEmpty)
                  TextButton(
                    onPressed: () => provider.clearQueue(),
                    child: const Text('Clear Queue', style: TextStyle(color: Color(0xFFF35588))),
                  ),
              ],
            ),
          ),
          Expanded(
            child: provider.queue.isEmpty
                ? const Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.playlist_play, size: 48, color: Colors.grey),
                        SizedBox(height: 8),
                        Text('Queue is empty. Add songs from your library!', style: TextStyle(color: Colors.grey)),
                      ],
                    ),
                  )
                : ListView.builder(
                    padding: const EdgeInsets.only(bottom: 90),
                    itemCount: provider.queue.length,
                    itemBuilder: (ctx, i) {
                      var track = provider.queue[i];
                      int trackIdInt = int.tryParse(track.id) ?? 0;
                      return ListTile(
                        leading: ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: SizedBox(
                            width: 40,
                            height: 40,
                            child: QueryArtworkWidget(
                              id: trackIdInt,
                              type: ArtworkType.AUDIO,
                              nullArtworkWidget: Container(
                                color: const Color(0xFF101424),
                                child: const Icon(Icons.music_note, color: Colors.grey),
                              ),
                            ),
                          ),
                        ),
                        title: Text(track.title, maxLines: 1, overflow: TextOverflow.ellipsis),
                        subtitle: Text(track.artist, maxLines: 1, overflow: TextOverflow.ellipsis),
                        trailing: IconButton(
                          icon: const Icon(Icons.close, color: Colors.grey),
                          onPressed: () => provider.removeFromQueue(i),
                        ),
                        onTap: () {
                          provider.playTrackByModel(track);
                          provider.removeFromQueue(i);
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

// Downloader Tab (Universal Multi-Domain Downloader)
class DownloaderTab extends StatefulWidget {
  const DownloaderTab({super.key});

  @override
  State<DownloaderTab> createState() => _DownloaderTabState();
}

class _DownloaderTabState extends State<DownloaderTab> {
  final TextEditingController _queryController = TextEditingController();
  final TextEditingController _langController = TextEditingController();

  String _selectedDomain = 'all';
  final List<Map<String, String>> _domainFilters = [
    {'id': 'all', 'label': 'All Domains'},
    {'id': 'youtube', 'label': 'YouTube'},
    {'id': 'soundcloud', 'label': 'SoundCloud'},
    {'id': 'archive', 'label': 'Archive.org'},
    {'id': 'direct', 'label': 'Direct MP3'},
  ];

  final List<String> _quickLanguages = ['All', 'English', 'Hindi', 'Telugu', 'Punjabi', 'Spanish'];

  Color _getSourceColor(String source) {
    if (source.contains('YouTube')) return const Color(0xFFFF4D4D);
    if (source.contains('SoundCloud')) return const Color(0xFFFF7700);
    if (source.contains('Archive')) return const Color(0xFF4D94FF);
    if (source.contains('Direct')) return const Color(0xFF00F2FE);
    return const Color(0xFFF35588);
  }

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<KiwiMusicProvider>(context);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                const Text(
                  'Universal Downloader',
                  style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: const Color(0xFF00F2FE).withOpacity(0.15),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: const Color(0xFF00F2FE).withOpacity(0.3)),
                  ),
                  child: const Text('MULTI-TIER', style: TextStyle(fontSize: 10, color: Color(0xFF00F2FE), fontWeight: FontWeight.bold)),
                ),
              ],
            ),
            const SizedBox(height: 4),
            const Text(
              'Search across domains or paste ANY link (YouTube, SoundCloud, MP3 URL)',
              style: TextStyle(fontSize: 12, color: Colors.grey),
            ),
            const SizedBox(height: 12),

            // Search / URL input
            TextField(
              controller: _queryController,
              decoration: InputDecoration(
                hintText: 'Song name, artist, or paste ANY URL...',
                prefixIcon: const Icon(Icons.link_rounded, color: Colors.grey),
                filled: true,
                fillColor: const Color(0xFF101424),
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                suffixIcon: IconButton(
                  icon: const Icon(Icons.clear, size: 18, color: Colors.grey),
                  onPressed: () => _queryController.clear(),
                ),
              ),
            ),
            const SizedBox(height: 8),

            // Domain Filter Chips
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: _domainFilters.map((df) {
                  bool isSel = _selectedDomain == df['id'];
                  return Padding(
                    padding: const EdgeInsets.only(right: 6.0),
                    child: FilterChip(
                      label: Text(df['label']!, style: TextStyle(fontSize: 11, color: isSel ? const Color(0xFF00F2FE) : Colors.grey)),
                      selected: isSel,
                      selectedColor: const Color(0xFF00F2FE).withOpacity(0.2),
                      backgroundColor: const Color(0xFF101424),
                      side: BorderSide(color: isSel ? const Color(0xFF00F2FE).withOpacity(0.5) : Colors.white10),
                      onSelected: (_) {
                        setState(() => _selectedDomain = df['id']!);
                      },
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 6),

            // Language Selector Chips
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: _quickLanguages.map((lang) {
                  return Padding(
                    padding: const EdgeInsets.only(right: 6.0),
                    child: ActionChip(
                      label: Text(lang, style: const TextStyle(fontSize: 11)),
                      backgroundColor: _langController.text == (lang == 'All' ? '' : lang)
                          ? const Color(0xFF00F2FE).withOpacity(0.2)
                          : const Color(0xFF101424),
                      onPressed: () {
                        setState(() {
                          _langController.text = lang == 'All' ? '' : lang;
                        });
                      },
                    ),
                  );
                }).toList(),
              ),
            ),
            const SizedBox(height: 12),

            // Search Action Button
            SizedBox(
              width: double.infinity,
              height: 48,
              child: ElevatedButton.icon(
                onPressed: provider.isSearchingOnline
                    ? null
                    : () => provider.searchOnline(_queryController.text, _langController.text, domain: _selectedDomain),
                icon: const Icon(Icons.cloud_download),
                label: const Text('Search & Resolve Audio Streams', style: TextStyle(fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF00F2FE),
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ),
            const SizedBox(height: 16),

            // Results List
            Expanded(
              child: provider.isSearchingOnline
                  ? const Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          CircularProgressIndicator(color: Color(0xFF00F2FE)),
                          SizedBox(height: 12),
                          Text('Querying multi-source crawlers & stream resolvers...', style: TextStyle(color: Colors.grey)),
                        ],
                      ),
                    )
                  : provider.searchResults.isEmpty
                      ? const Center(
                          child: Text(
                            'Search above or paste any audio URL to download.',
                            style: TextStyle(color: Colors.grey),
                          ),
                        )
                      : ListView.builder(
                          padding: const EdgeInsets.only(bottom: 90),
                          itemCount: provider.searchResults.length,
                          itemBuilder: (ctx, i) {
                            var item = provider.searchResults[i];
                            double progress = provider.downloadProgress[item.url] ?? 0.0;
                            String statusText = provider.downloadStatus[item.url] ?? '';
                            Color sourceColor = _getSourceColor(item.source);

                            return Card(
                              color: const Color(0xFF101424),
                              margin: const EdgeInsets.only(bottom: 10),
                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                              child: Padding(
                                padding: const EdgeInsets.all(12.0),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                          decoration: BoxDecoration(
                                            color: sourceColor.withOpacity(0.15),
                                            borderRadius: BorderRadius.circular(6),
                                            border: Border.all(color: sourceColor.withOpacity(0.4)),
                                          ),
                                          child: Text(
                                            item.source.toUpperCase(),
                                            style: TextStyle(fontSize: 9, fontWeight: FontWeight.bold, color: sourceColor),
                                          ),
                                        ),
                                        if (item.duration.isNotEmpty) ...[
                                          const SizedBox(width: 8),
                                          Text(item.duration, style: const TextStyle(fontSize: 10, color: Colors.grey, fontFamily: 'monospace')),
                                        ],
                                      ],
                                    ),
                                    const SizedBox(height: 6),
                                    Text(
                                      item.title,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.white),
                                    ),
                                    Text(
                                      '${item.artist} • ${item.url}',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(fontSize: 10, color: Colors.grey),
                                    ),
                                    const SizedBox(height: 8),
                                    if (progress > 0.0 && progress < 1.0) ...[
                                      LinearProgressIndicator(
                                        value: progress,
                                        backgroundColor: Colors.white10,
                                        valueColor: const AlwaysStoppedAnimation<Color>(Color(0xFF00F2FE)),
                                        minHeight: 4,
                                      ),
                                      const SizedBox(height: 4),
                                      Text(statusText, style: const TextStyle(fontSize: 10, color: Color(0xFF00F2FE))),
                                    ] else if (progress == 1.0) ...[
                                      const Row(
                                        children: [
                                          Icon(Icons.check_circle, color: Colors.green, size: 16),
                                          SizedBox(width: 6),
                                          Text('Saved to /Download!', style: TextStyle(fontSize: 11, color: Colors.green, fontWeight: FontWeight.bold)),
                                        ],
                                      ),
                                    ] else ...[
                                      Align(
                                        alignment: Alignment.centerRight,
                                        child: ElevatedButton.icon(
                                          onPressed: () => provider.downloadSong(item),
                                          icon: const Icon(Icons.download, size: 14),
                                          label: const Text('Download MP3', style: TextStyle(fontSize: 11, fontWeight: FontWeight.bold)),
                                          style: ElevatedButton.styleFrom(
                                            backgroundColor: const Color(0xFF00F2FE),
                                            foregroundColor: Colors.black,
                                            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                                          ),
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            );
                          },
                        ),
            ),
          ],
        ),
      ),
    );
  }
}

// Persistent Bottom Player Drawer (Mini-Player)
class PersistentPlayerDrawer extends StatelessWidget {
  const PersistentPlayerDrawer({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<KiwiMusicProvider>(context);
    final track = provider.currentTrack;

    if (track == null) return const SizedBox.shrink();

    double progressPct = 0.0;
    if (provider.duration.inMilliseconds > 0) {
      progressPct = provider.position.inMilliseconds / provider.duration.inMilliseconds;
    }
    int trackIdInt = int.tryParse(track.id) ?? 0;

    return GestureDetector(
      onTap: () {
        showModalBottomSheet(
          context: context,
          isScrollControlled: true,
          backgroundColor: Colors.transparent,
          builder: (_) => const FullPlayerSheet(),
        );
      },
      child: Container(
        height: 72,
        margin: const EdgeInsets.only(bottom: 56),
        decoration: const BoxDecoration(
          color: Color(0xFF0A0C16),
          border: Border(top: BorderSide(color: Colors.white10)),
        ),
        child: Column(
          children: [
            LinearProgressIndicator(
              value: progressPct.clamp(0.0, 1.0),
              backgroundColor: Colors.white12,
              valueColor: const AlwaysStoppedAnimation<Color>(Color(0xFF00F2FE)),
              minHeight: 3,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16.0, vertical: 8.0),
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(6),
                    child: SizedBox(
                      width: 42,
                      height: 42,
                      child: QueryArtworkWidget(
                        id: trackIdInt,
                        type: ArtworkType.AUDIO,
                        nullArtworkWidget: Container(
                          color: const Color(0xFF101424),
                          child: const Icon(Icons.music_note, color: Color(0xFF00F2FE), size: 20),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          track.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13),
                        ),
                        Text(
                          track.artist,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Colors.grey, fontSize: 11),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_previous, size: 22),
                    onPressed: () => provider.playPrevious(),
                  ),
                  IconButton(
                    icon: Icon(provider.isPlaying ? Icons.pause_circle_filled : Icons.play_circle_filled),
                    iconSize: 32,
                    color: const Color(0xFF00F2FE),
                    onPressed: () => provider.togglePlay(),
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_next, size: 22),
                    onPressed: () => provider.playNext(),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// Full Player Expandable Modal Sheet
class FullPlayerSheet extends StatelessWidget {
  const FullPlayerSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<KiwiMusicProvider>(context);
    final track = provider.currentTrack;

    if (track == null) {
      return Container(
        height: 200,
        color: const Color(0xFF080A10),
        child: const Center(child: Text('No song currently playing')),
      );
    }

    int trackIdInt = int.tryParse(track.id) ?? 0;
    double currentPosMs = provider.position.inMilliseconds.toDouble();
    double totalDurMs = provider.duration.inMilliseconds.toDouble();
    if (totalDurMs <= 0) totalDurMs = 1.0;

    return Container(
      height: MediaQuery.of(context).size.height * 0.88,
      decoration: const BoxDecoration(
        color: Color(0xFF0A0C16),
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24.0, vertical: 12.0),
          child: Column(
            children: [
              // Pull Handle
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.white24,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(height: 12),

              // Top Bar
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  IconButton(
                    icon: const Icon(Icons.keyboard_arrow_down, size: 28),
                    onPressed: () => Navigator.pop(context),
                  ),
                  const Text(
                    'NOW PLAYING',
                    style: TextStyle(letterSpacing: 2, fontSize: 12, fontWeight: FontWeight.bold, color: Colors.grey),
                  ),
                  IconButton(
                    icon: const Icon(Icons.playlist_play, size: 24),
                    onPressed: () {
                      Navigator.pop(context);
                    },
                  ),
                ],
              ),
              const Spacer(),

              // Album Artwork
              Center(
                child: Container(
                  width: 260,
                  height: 260,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(20),
                    boxShadow: [
                      BoxShadow(
                        color: const Color(0xFF00F2FE).withOpacity(0.15),
                        blurRadius: 30,
                        spreadRadius: 5,
                      ),
                    ],
                  ),
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(20),
                    child: QueryArtworkWidget(
                      id: trackIdInt,
                      type: ArtworkType.AUDIO,
                      artworkWidth: 260,
                      artworkHeight: 260,
                      artworkFit: BoxFit.cover,
                      nullArtworkWidget: Container(
                        color: const Color(0xFF101424),
                        child: const Icon(Icons.music_note, size: 100, color: Color(0xFF00F2FE)),
                      ),
                    ),
                  ),
                ),
              ),
              const Spacer(),

              // Title and Artist
              Align(
                alignment: Alignment.centerLeft,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      track.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.white),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${track.artist} • ${track.album}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14, color: Colors.grey),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              // Interactive Seek Slider
              SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: 4,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                  overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                  activeTrackColor: const Color(0xFF00F2FE),
                  inactiveTrackColor: Colors.white12,
                  thumbColor: const Color(0xFF00F2FE),
                ),
                child: Slider(
                  value: currentPosMs.clamp(0.0, totalDurMs),
                  min: 0.0,
                  max: totalDurMs,
                  onChanged: (val) {
                    provider.seek(Duration(milliseconds: val.toInt()));
                  },
                ),
              ),

              // Duration Timers
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16.0),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(formatDuration(provider.position), style: const TextStyle(fontSize: 12, color: Colors.grey)),
                    Text(formatDuration(provider.duration), style: const TextStyle(fontSize: 12, color: Colors.grey)),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              // Controls Bar
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  IconButton(
                    icon: Icon(
                      Icons.shuffle,
                      color: provider.isShuffle ? const Color(0xFF00F2FE) : Colors.grey,
                    ),
                    onPressed: () => provider.toggleShuffle(),
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_previous, size: 36),
                    onPressed: () => provider.playPrevious(),
                  ),
                  Container(
                    width: 64,
                    height: 64,
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: Color(0xFF00F2FE),
                    ),
                    child: IconButton(
                      icon: Icon(
                        provider.isPlaying ? Icons.pause : Icons.play_arrow,
                        color: Colors.black,
                        size: 36,
                      ),
                      onPressed: () => provider.togglePlay(),
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.skip_next, size: 36),
                    onPressed: () => provider.playNext(),
                  ),
                  IconButton(
                    icon: Icon(
                      provider.repeatMode == RepeatMode.one
                          ? Icons.repeat_one
                          : Icons.repeat,
                      color: provider.repeatMode != RepeatMode.off ? const Color(0xFF00F2FE) : Colors.grey,
                    ),
                    onPressed: () => provider.toggleRepeat(),
                  ),
                ],
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
