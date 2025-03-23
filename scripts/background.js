/**
 * SimpleReader - Background Script
 * Handles API communication and audio playback
 */

// OpenAI TTS API endpoint
const TTS_API_ENDPOINT = 'https://api.openai.com/v1/audio/speech';

// Default settings - using latest model by default
const DEFAULT_SETTINGS = {
  voice: 'coral', // Default to more expressive voice
  model: 'gpt-4o-mini-tts', // Default to latest model
  speed: 1.0,
  tone: 'natural',
  apiKey: ''
};

// Available TTS models - only latest models
const TTS_MODELS = {
  'gpt-4o-mini-tts': 'GPT-4o Mini TTS (Latest)',
  'tts-1-1106': 'TTS 1106 (Latest)'
};

// Available voices
const TTS_VOICES = {
  'alloy': 'Alloy (Neutral)',
  'echo': 'Echo (Male)',
  'fable': 'Fable (British)',
  'onyx': 'Onyx (Male)',
  'nova': 'Nova (Female)',
  'shimmer': 'Shimmer (Female)',
  'coral': 'Coral (Expressive)'
};

// Tone instructions for the models
const TTS_TONES = {
  'natural': 'Speak in a natural, conversational tone.',
  'cheerful': 'Speak in a cheerful and positive tone.',
  'formal': 'Speak in a formal and professional tone.',
  'serious': 'Speak in a serious and direct tone.',
  'excited': 'Speak with enthusiasm and excitement.'
};

// Global audio tracker and state management
let activeAudioTabId = null;
let audioState = {
  currentSection: 0,
  totalSections: 0,
  isPaused: false
};

// Global storage for processed audio chunks
let processedAudioChunks = [];
let currentChunkIndex = 0;

// Global queue for pre-fetched audio sections
let audioQueue = [];
let isFetchingNext = false;
let currentPlaybackTabId = null;
let sectionQueue = []; // Make sectionQueue global

// Global timeout and listener references
let sectionTimeoutCheck = null;
let sectionCompletionCheck = null;
let globalSectionTimeout = null;
let currentAudioEndedListener = null;

// Listen for extension icon clicks
chrome.action.onClicked.addListener(async (tab) => {
  console.log('Extension icon clicked, opening modal on tab:', tab.id);
  try {
    // Check if API key is set
    const settings = await getSettings();
    if (!settings.apiKey) {
      // If no API key is set, open options page
      chrome.runtime.openOptionsPage();
      return;
    }
    
    // Open modal on the page
    await createOrUpdateModal(tab.id, 'ready', null, tab.id);
  } catch (error) {
    console.error('Error handling extension click:', error);
  }
});

// Get settings from storage
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (result) => {
      const settings = result.settings || DEFAULT_SETTINGS;
      
      // Force latest model if not already using one
      if (!['gpt-4o-mini-tts', 'tts-1-1106'].includes(settings.model)) {
        settings.model = DEFAULT_SETTINGS.model;
      }
      
      resolve(settings);
    });
  });
}

// Handle messages from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Background received message:', request.action, request);
  
  if (request.action === 'readPage') {
    readPage(request.tabId)
      .then(response => sendResponse(response))
      .catch(error => {
        console.error('Error in readPage:', error);
        sendResponse({ error: error.message || 'Unknown error occurred' });
      });
    
    return true; // Required for async response
  }
  
  if (request.action === 'stopAudio') {
    stopAudio(request.tabId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message || 'Error stopping audio' }));
    
    return true;
  }
  
  if (request.action === 'pauseAudio') {
    pauseAudio(request.tabId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message || 'Error pausing audio' }));
    
    return true;
  }
  
  if (request.action === 'resumeAudio') {
    resumeAudio(request.tabId)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message || 'Error resuming audio' }));
    
    return true;
  }
  
  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }
});

// Extract content from the page - simplified to get the entire article at once
async function extractContentFromPage(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      function: () => {
        console.log('Extracting entire article content');
        
        // Helper function to clean text
        function cleanText(text) {
          if (!text) return '';
          return text.replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n\n')
            .trim();
        }

        // Find the most likely article container
        function findArticleContainer() {
          // Possible article container selectors in order of priority
          const articleSelectors = [
            'article',
            '[role="article"]',
            '.article', 
            '.post-content',
            '.post',
            '.entry-content',
            '.content-area',
            '.story',
            'main',
            '#main',
            '.main'
          ];
          
          // Try each selector
          for (const selector of articleSelectors) {
            const elements = document.querySelectorAll(selector);
            
            // Find the element with the most text content among matches
            if (elements.length > 0) {
              let bestElement = null;
              let maxLength = 0;
              
              for (const el of elements) {
                // Skip if not visible
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                
                const textLength = el.textContent.trim().length;
                if (textLength > maxLength) {
                  maxLength = textLength;
                  bestElement = el;
                }
              }
              
              if (bestElement && maxLength > 500) {
                console.log(`Found article container with selector: ${selector}`);
                return bestElement;
              }
            }
          }
          
          // Fallback: look for the largest text block in the page
          const contentBlocks = Array.from(document.querySelectorAll('div, section'))
            .filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.width > 200 && 
                     rect.height > 100 && 
                     el.textContent.trim().length > 500;
            })
            .sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
          
          if (contentBlocks.length > 0) {
            console.log('Found article container using content block analysis');
            return contentBlocks[0];
          }
          
          console.log('No specific article container found, using body');
          return document.body;
        }
        
        try {
          // Find the main article container
          const articleContainer = findArticleContainer();
          
          // Get all paragraph text in the container
          const paragraphs = Array.from(articleContainer.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))
            .filter(el => el.textContent.trim().length > 0)
            .map(el => {
              // For headings, add a marker
              if (el.tagName.match(/^H[1-6]$/)) {
                return `[Heading: ${cleanText(el.textContent)}]`;
              }
              return cleanText(el.textContent);
            });
          
          // Join all paragraphs with line breaks
          const fullText = paragraphs.join('\n\n');
          
          console.log(`Extracted ${paragraphs.length} paragraphs, total length: ${fullText.length} characters`);
          
          return {
            title: document.title,
            content: fullText,
            success: true
          };
        } catch (error) {
          console.error('Error extracting content:', error);
          return {
            title: document.title,
            content: document.body.innerText.substring(0, 10000),
            error: error.message,
            success: false
          };
        }
      }
    })
    .then(results => {
      if (!results || results.length === 0) {
        reject(new Error('Failed to extract content'));
        return;
      }
      
      const result = results[0].result;
      if (!result.success) {
        console.warn('Content extraction had an error, but we have fallback content:', result.error);
      }
      
      resolve(result);
    })
    .catch(error => {
      console.error('Error in content extraction script execution:', error);
      reject(error);
    });
  });
}

// Convert text to speech using OpenAI API
async function convertTextToSpeech(text, sectionTitle = '') {
  console.log('Converting text to speech');
  const settings = await getSettings();
  
  if (!settings.apiKey) {
    throw new Error('OpenAI API key not set. Please add your API key in the extension settings.');
  }
  
  // Limit text length to prevent excessive API usage
  const maxLength = 4000;
  const truncatedText = text.length > maxLength ? 
    text.substring(0, maxLength) + '...' : 
    text;
  
  // Add section title as context if provided
  const inputText = sectionTitle ? 
    `${sectionTitle}\n\n${truncatedText}` : 
    truncatedText;
  
  console.log(`Converting section ${sectionTitle ? '"' + sectionTitle + '"' : ''}: ${truncatedText.length} characters`);
  
  try {
    // Build the request payload
    const payload = {
      model: settings.model,
      input: inputText,
      voice: settings.voice,
      response_format: 'mp3'
    };
    
    // Add instructions parameter (supported by all latest models)
    if (settings.tone) {
      payload.instructions = TTS_TONES[settings.tone] || TTS_TONES.natural;
    }
    
    // Add speed only if tts-1-1106 model
    if (settings.model === 'tts-1-1106') {
      payload.speed = settings.speed;
    }
    
    console.log('API request payload for section:', {
      ...payload,
      input: inputText.substring(0, 100) + '...' // Log just beginning for brevity
    });
    
    const response = await fetch(TTS_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMessage = errorData.error?.message || `API error: ${response.status} ${response.statusText}`;
      console.error('API response error:', errorMessage);
      throw new Error(errorMessage);
    }
    
    const audioData = await response.arrayBuffer();
    console.log(`Received audio data: ${audioData.byteLength} bytes`);
    return audioData;
  } catch (error) {
    console.error('Error converting text to speech:', error);
    throw error;
  }
}

// Process and play sections of content with streaming approach
async function processAndPlaySections(tabId, sections) {
  console.log(`Processing ${sections.length} sections for tab ${tabId}`);
  
  // Reset state
  audioQueue = [];
  isFetchingNext = false;
  currentPlaybackTabId = tabId;
  sectionQueue = [...sections];
  
  // Update global audio state
  audioState = {
    currentSection: 0,
    totalSections: sections.length,
    isPaused: false
  };
  
  // Clear timeouts
  clearAllTimeouts();
  
  // Start with first section
  await createOrUpdateModal(tabId, 'reading', 'Preparing article...', tabId);
  
  // Process sections sequentially, but only pre-fetch one at a time
  await playSectionsInOrder(tabId, 0);
}

// Clear all timeout handlers
function clearAllTimeouts() {
  if (sectionTimeoutCheck) {
    clearTimeout(sectionTimeoutCheck);
    sectionTimeoutCheck = null;
  }
  
  if (sectionCompletionCheck) {
    clearTimeout(sectionCompletionCheck);
    sectionCompletionCheck = null;
  }
  
  if (globalSectionTimeout) {
    clearTimeout(globalSectionTimeout);
    globalSectionTimeout = null;
  }
  
  if (currentAudioEndedListener) {
    chrome.runtime.onMessage.removeListener(currentAudioEndedListener);
    currentAudioEndedListener = null;
  }
}

// Play sections in strict sequential order
async function playSectionsInOrder(tabId, startIndex) {
  // If playback was stopped
  if (!currentPlaybackTabId) {
    console.log('Playback stopped');
    return;
  }
  
  // Check if we've reached the end
  if (startIndex >= sectionQueue.length) {
    console.log('All sections completed');
    await createOrUpdateModal(tabId, 'complete', 'Finished reading the page', tabId);
    return;
  }
  
  const currentSection = sectionQueue[startIndex];
  
  try {
    // Update state and UI for current section
    audioState.currentSection = startIndex + 1;
    
    // Show user we're processing this section
    await createOrUpdateModal(
      tabId, 
      'reading', 
      `Preparing section ${startIndex + 1} of ${sectionQueue.length}...`, 
      tabId
    );
    
    // Handle heading-only sections differently
    if (currentSection.type === 'heading') {
      console.log(`Section ${startIndex + 1} is heading-only, moving to next`);
      
      // Update UI to show we're moving to next section
      await createOrUpdateModal(
        tabId, 
        'playing', 
        `Section ${startIndex + 1} of ${sectionQueue.length}: ${currentSection.title}`, 
        tabId
      );
      
      // Move to next section immediately
      setTimeout(() => playSectionsInOrder(tabId, startIndex + 1), 200);
      return;
    }
    
    // Convert to speech
    console.log(`Converting section ${startIndex + 1} to speech`);
    const audioData = await convertTextToSpeech(currentSection.content, currentSection.title);
    
    // Update UI to show we're playing this section
    await createOrUpdateModal(
      tabId, 
      'playing', 
      `Playing ${startIndex + 1} of ${sectionQueue.length}: ${currentSection.title}`, 
      tabId
    );
    
    // Play the audio and only when complete, move to next section
    await playAudioAndWaitForCompletion(tabId, audioData, () => {
      console.log(`Section ${startIndex + 1} completed, moving to next section`);
      playSectionsInOrder(tabId, startIndex + 1);
    });
    
  } catch (error) {
    console.error(`Error processing section ${startIndex + 1}:`, error);
    await createOrUpdateModal(tabId, 'error', `Error: ${error.message}`, tabId);
    
    // Try to continue with next section even after error
    setTimeout(() => playSectionsInOrder(tabId, startIndex + 1), 1000);
  }
}

// Play audio and wait for completion with a more reliable approach
async function playAudioAndWaitForCompletion(tabId, audioData, onComplete) {
  // This is a simplified version of playAudioInTab
  try {
    // Update global state
    activeAudioTabId = tabId;
    
    // Convert audio to base64
    const base64Audio = arrayBufferToBase64(audioData);
    
    // Setup a promise-based completion mechanism
    return new Promise((resolve) => {
      // Set up listener for completion
      const messageListener = (message) => {
        if (message.action === 'audioEnded') {
          // Clean up listener
          chrome.runtime.onMessage.removeListener(messageListener);
          
          // Call the completion callback
          onComplete();
          resolve();
        }
      };
      
      // Register listener
      chrome.runtime.onMessage.addListener(messageListener);
      
      // Execute script to play audio in tab
      chrome.scripting.executeScript({
        target: { tabId },
        function: (audioSrc, isPaused) => {
          console.log('Creating audio element in page');
          
          // Create audio element
          const audioElement = document.createElement('audio');
          audioElement.id = 'simpereader-audio';
          audioElement.style.display = 'none';
          audioElement.src = `data:audio/mp3;base64,${audioSrc}`;
          
          // Simple ended event handler
          audioElement.onended = () => {
            console.log('Audio playback ended');
            // Notify background script
            chrome.runtime.sendMessage({ action: 'audioEnded' });
          };
          
          // Remove existing audio
          const existingAudio = document.getElementById('simpereader-audio');
          if (existingAudio) {
            existingAudio.pause();
            existingAudio.remove();
          }
          
          // Add to document
          document.body.appendChild(audioElement);
          
          // Store for pause/resume
          window.simpleReaderAudio = audioElement;
          
          // Don't play if paused
          if (isPaused) return;
          
          // Play the audio
          const playPromise = audioElement.play();
          if (playPromise) {
            playPromise.catch(error => {
              console.error('Error playing audio:', error);
              
              // Create play button for autoplay blocked scenarios
              if (error.name === 'NotAllowedError') {
                // Create a modal with play button
                let container = document.createElement('div');
                container.id = 'simpleReader-play-prompt';
                container.style.cssText = `
                  position: fixed;
                  top: 0;
                  left: 0;
                  width: 100%;
                  height: 100%;
                  background-color: rgba(0, 0, 0, 0.7);
                  display: flex;
                  justify-content: center;
                  align-items: center;
                  z-index: 999999;
                `;
                
                const modal = document.createElement('div');
                modal.style.cssText = `
                  background-color: white;
                  border-radius: 8px;
                  padding: 20px;
                  text-align: center;
                  max-width: 400px;
                `;
                
                const heading = document.createElement('h3');
                heading.textContent = 'SimpleReader needs permission';
                heading.style.marginBottom = '15px';
                
                const message = document.createElement('p');
                message.textContent = 'Click the button below to start audio playback';
                message.style.marginBottom = '20px';
                
                const button = document.createElement('button');
                button.textContent = 'Play Audio';
                button.style.cssText = `
                  background-color: #3a86ff;
                  color: white;
                  border: none;
                  padding: 10px 20px;
                  border-radius: 4px;
                  cursor: pointer;
                `;
                
                button.onclick = () => {
                  audioElement.play()
                    .then(() => container.remove())
                    .catch(err => {
                      message.textContent = 'Error: ' + err.message;
                      message.style.color = 'red';
                    });
                };
                
                modal.appendChild(heading);
                modal.appendChild(message);
                modal.appendChild(button);
                container.appendChild(modal);
                document.body.appendChild(container);
              }
            });
          }
        },
        args: [base64Audio, audioState.isPaused]
      });
      
      // Set a safety timeout (5 minutes) in case the audio never ends
      setTimeout(() => {
        chrome.runtime.onMessage.removeListener(messageListener);
        onComplete();
        resolve();
      }, 5 * 60 * 1000);
    });
  } catch (error) {
    console.error('Error playing audio in tab:', error);
    onComplete();
    throw error;
  }
}

// Create or update the modal displayed on the page
async function createOrUpdateModal(tabId, action, message, sourceTabId) {
  console.log(`Updating modal in tab ${tabId} - Action: ${action}, Message: ${message}`);
  
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      function: (action, message, sourceTabId, audioState) => {
        function createModal() {
          console.log('Creating modal in page');
          
          // Create modal container if it doesn't exist
          let container = document.getElementById('simpleReader-modal-container');
          if (!container) {
            container = document.createElement('div');
            container.id = 'simpleReader-modal-container';
            container.style.cssText = `
              position: fixed;
              top: 20px;
              right: 20px;
              z-index: 999999;
              max-width: 350px;
              width: 100%;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            `;
            document.body.appendChild(container);
          }
          
          // Create the modal
          let modal = document.getElementById('simpleReader-modal');
          if (!modal) {
            modal = document.createElement('div');
            modal.id = 'simpleReader-modal';
            modal.style.cssText = `
              background-color: white;
              border-radius: 8px;
              box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
              padding: 16px;
              transition: all 0.3s ease;
              opacity: 0;
              transform: translateY(-10px);
            `;
            container.appendChild(modal);
            
            // Animate in
            setTimeout(() => {
              modal.style.opacity = '1';
              modal.style.transform = 'translateY(0)';
            }, 10);
          }
          
          return modal;
        }
        
        // Add necessary content to the modal based on action
        function updateModal(modal, action, message) {
          // Clear existing content
          modal.innerHTML = '';
          
          // Header with logo and title
          const header = document.createElement('div');
          header.style.cssText = `
            display: flex;
            align-items: center;
            margin-bottom: 12px;
          `;
          
          const title = document.createElement('h3');
          title.textContent = 'SimpleReader';
          title.style.cssText = `
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: #333;
          `;
          
          const close = document.createElement('button');
          close.innerHTML = '&times;';
          close.style.cssText = `
            background: none;
            border: none;
            font-size: 20px;
            color: #666;
            cursor: pointer;
            margin-left: auto;
            padding: 0;
            width: 24px;
            height: 24px;
            line-height: 24px;
            text-align: center;
          `;
          close.addEventListener('click', () => {
            try {
              // Send message to stop audio
              chrome.runtime.sendMessage({ 
                action: 'stopAudio',
                tabId: sourceTabId
              }).catch(e => console.error('Error sending stopAudio message:', e));
              
              // Remove modal
              const container = document.getElementById('simpleReader-modal-container');
              if (container) {
                container.style.opacity = '0';
                container.style.transform = 'translateY(-10px)';
                setTimeout(() => container.remove(), 300);
              }
            } catch (e) {
              console.error('Error in close button handler:', e);
            }
          });
          
          header.appendChild(title);
          header.appendChild(close);
          modal.appendChild(header);
          
          // Status section
          const statusContainer = document.createElement('div');
          statusContainer.style.cssText = 'margin-bottom: 16px;';
          
          const statusEl = document.createElement('div');
          statusEl.id = 'simplereader-status';
          statusEl.style.cssText = `
            font-size: 14px;
            color: #555;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
          `;
          
          // Set status based on action
          let statusText = message || '';
          let statusColor = '#555';
          
          switch (action) {
            case 'ready':
              statusText = 'Ready to read page';
              statusColor = '#3a86ff';
              break;
            case 'reading':
              statusColor = '#3a86ff';
              break;
            case 'playing':
              statusText = audioState.isPaused ? 'Paused' : 'Playing audio...';
              statusColor = audioState.isPaused ? '#ff9800' : '#4caf50';
              break;
            case 'error':
              statusColor = '#f44336';
              break;
            case 'complete':
              statusText = 'Finished reading';
              statusColor = '#4caf50';
              break;
          }
          
          statusEl.textContent = statusText;
          statusEl.style.color = statusColor;
          statusContainer.appendChild(statusEl);
          
          // Add loading spinner for 'reading' state
          if (action === 'reading') {
            const spinner = document.createElement('div');
            spinner.style.cssText = `
              display: inline-block;
              width: 12px;
              height: 12px;
              border: 2px solid rgba(58, 134, 255, 0.3);
              border-radius: 50%;
              border-top-color: #3a86ff;
              animation: spin 1s linear infinite;
              margin-left: 8px;
            `;
            
            // Add the animation style
            if (!document.getElementById('spinner-style')) {
              const style = document.createElement('style');
              style.id = 'spinner-style';
              style.textContent = `
                @keyframes spin {
                  to { transform: rotate(360deg); }
                }
              `;
              document.head.appendChild(style);
            }
            
            statusEl.appendChild(spinner);
            
            // Add time elapsed counter when in reading state for longer processes
            const timeInfoEl = document.createElement('div');
            timeInfoEl.id = 'simplereader-time-info';
            timeInfoEl.style.cssText = `
              font-size: 12px;
              color: #666;
              margin-top: 6px;
            `;
            
            // Initialize the start time if not already set
            if (!window.simpleReaderStartTime) {
              window.simpleReaderStartTime = Date.now();
            }
            
            // Show time elapsed
            const updateTimeElapsed = () => {
              if (action !== 'reading') {
                clearInterval(window.timeUpdateInterval);
                window.simpleReaderStartTime = null;
                return;
              }
              
              const elapsedSec = Math.floor((Date.now() - window.simpleReaderStartTime) / 1000);
              timeInfoEl.textContent = `Processing: ${elapsedSec}s elapsed`;
            };
            
            updateTimeElapsed();
            
            // Update the elapsed time every second
            clearInterval(window.timeUpdateInterval);
            window.timeUpdateInterval = setInterval(updateTimeElapsed, 1000);
            
            statusContainer.appendChild(timeInfoEl);
          } else {
            // Clear the time counter when not in reading state
            clearInterval(window.timeUpdateInterval);
            window.simpleReaderStartTime = null;
          }
          
          // Progress bar for reading state
          if (action === 'reading' || action === 'playing') {
            const progressContainer = document.createElement('div');
            progressContainer.id = 'simplereader-progress-container';
            progressContainer.style.cssText = `
              width: 100%;
              height: 4px;
              background-color: #eee;
              border-radius: 2px;
              overflow: hidden;
              margin-top: 8px;
            `;
            
            const progressBar = document.createElement('div');
            progressBar.id = 'simplereader-progress';
            progressBar.style.cssText = `
              height: 100%;
              background-color: ${action === 'playing' ? (audioState.isPaused ? '#ff9800' : '#4caf50') : '#3a86ff'};
              width: ${action === 'playing' ? '100%' : '0'};
              transition: width 0.3s ease;
            `;
            
            // Animate progress for reading state
            if (action === 'reading') {
              progressBar.style.width = '90%';
              progressBar.style.transition = 'width 2s ease';
            }
            
            progressContainer.appendChild(progressBar);
            statusContainer.appendChild(progressContainer);
          }
          
          // If we're showing sections info
          if (action === 'playing' && message && message.includes('Section')) {
            const sectionInfo = document.createElement('div');
            sectionInfo.id = 'simplereader-section-info';
            sectionInfo.style.cssText = `
              font-size: 13px;
              color: #666;
              margin-top: 6px;
              font-style: italic;
            `;
            sectionInfo.textContent = message;
            statusContainer.appendChild(sectionInfo);
          }
          
          // Section counter
          if (action === 'playing' && audioState.totalSections > 0) {
            const sectionCounter = document.createElement('div');
            sectionCounter.style.cssText = `
              font-size: 12px;
              color: #666;
              margin-top: 8px;
              text-align: right;
            `;
            sectionCounter.textContent = `Section ${audioState.currentSection} of ${audioState.totalSections}`;
            statusContainer.appendChild(sectionCounter);
          }
          
          modal.appendChild(statusContainer);
          
          // Add buttons based on state
          const buttonContainer = document.createElement('div');
          buttonContainer.style.cssText = `
            display: flex;
            gap: 8px;
          `;
          
          // If ready or error, show read button
          if (action === 'ready' || action === 'error' || action === 'complete') {
            const readButton = document.createElement('button');
            readButton.textContent = 'Read Page';
            readButton.style.cssText = `
              background-color: #3a86ff;
              color: white;
              border: none;
              border-radius: 4px;
              padding: 8px 16px;
              font-size: 14px;
              cursor: pointer;
              flex: 1;
            `;
            readButton.addEventListener('click', () => {
              try {
                // Update UI immediately
                statusEl.textContent = 'Starting...';
                readButton.disabled = true;
                readButton.style.opacity = '0.7';
                
                chrome.runtime.sendMessage({ 
                  action: 'readPage',
                  tabId: sourceTabId
                }).catch(e => console.error('Error sending readPage message:', e));
              } catch (e) {
                console.error('Error in read button handler:', e);
                statusEl.textContent = 'Error: ' + e.message;
                statusEl.style.color = '#f44336';
                readButton.disabled = false;
                readButton.style.opacity = '1';
              }
            });
            buttonContainer.appendChild(readButton);
          }
          
          // If playing, show pause/resume and stop buttons
          if (action === 'playing') {
            // Pause/Resume button
            const pauseResumeButton = document.createElement('button');
            pauseResumeButton.textContent = audioState.isPaused ? 'Resume' : 'Pause';
            pauseResumeButton.style.cssText = `
              background-color: ${audioState.isPaused ? '#4caf50' : '#ff9800'};
              color: white;
              border: none;
              border-radius: 4px;
              padding: 8px 16px;
              font-size: 14px;
              cursor: pointer;
              flex: 1;
            `;
            pauseResumeButton.addEventListener('click', () => {
              try {
                // Update UI immediately to give feedback
                pauseResumeButton.disabled = true;
                pauseResumeButton.style.opacity = '0.7';
                
                chrome.runtime.sendMessage({ 
                  action: audioState.isPaused ? 'resumeAudio' : 'pauseAudio',
                  tabId: sourceTabId
                })
                .then(() => {
                  pauseResumeButton.disabled = false;
                  pauseResumeButton.style.opacity = '1';
                })
                .catch(e => console.error('Error sending pause/resume message:', e));
              } catch (e) {
                console.error('Error in pause/resume button handler:', e);
                pauseResumeButton.disabled = false;
                pauseResumeButton.style.opacity = '1';
              }
            });
            buttonContainer.appendChild(pauseResumeButton);
            
            // Stop button
            const stopButton = document.createElement('button');
            stopButton.textContent = 'Stop';
            stopButton.style.cssText = `
              background-color: #f44336;
              color: white;
              border: none;
              border-radius: 4px;
              padding: 8px 16px;
              font-size: 14px;
              cursor: pointer;
              flex: 1;
            `;
            stopButton.addEventListener('click', () => {
              try {
                // Update UI immediately to give feedback
                stopButton.disabled = true;
                stopButton.style.opacity = '0.7';
                
                chrome.runtime.sendMessage({ 
                  action: 'stopAudio',
                  tabId: sourceTabId
                })
                .then(() => {
                  stopButton.disabled = false;
                  stopButton.style.opacity = '1';
                })
                .catch(e => console.error('Error sending stopAudio message:', e));
              } catch (e) {
                console.error('Error in stop button handler:', e);
                stopButton.disabled = false;
                stopButton.style.opacity = '1';
              }
            });
            buttonContainer.appendChild(stopButton);
          }
          
          // Settings button (only show when not playing or when error)
          if (action !== 'reading') {
            const settingsButton = document.createElement('button');
            settingsButton.textContent = 'Settings';
            settingsButton.style.cssText = `
              background-color: #f0f0f0;
              color: #333;
              border: none;
              border-radius: 4px;
              padding: 8px 16px;
              font-size: 14px;
              cursor: pointer;
              flex: 1;
            `;
            settingsButton.addEventListener('click', () => {
              try {
                chrome.runtime.sendMessage({ action: 'openOptions' })
                  .catch(e => console.error('Error sending openOptions message:', e));
              } catch (e) {
                console.error('Error in settings button handler:', e);
              }
            });
            buttonContainer.appendChild(settingsButton);
          }
          
          modal.appendChild(buttonContainer);
          
          return modal;
        }
        
        try {
          const modal = createModal();
          updateModal(modal, action, message);
          return { success: true };
        } catch (error) {
          console.error('Error creating/updating modal:', error);
          return { error: error.message, success: false };
        }
      },
      args: [action, message, sourceTabId, audioState]
    })
    .then(results => {
      if (!results || results.length === 0) {
        console.warn('Empty results from modal script');
        reject(new Error('Failed to create/update modal'));
        return;
      }
      
      const result = results[0].result;
      if (!result.success) {
        console.warn('Modal creation/update failed:', result.error);
        reject(new Error(result.error || 'Failed to create/update modal'));
        return;
      }
      
      resolve(result);
    })
    .catch(error => {
      console.error('Error executing modal script:', error);
      reject(error);
    });
  });
}

// Update playAudioInTab to add more robust callback handling
async function playAudioInTab(tabId, audioData, onComplete = null) {
  console.log(`Playing audio in tab ${tabId}, ${audioData.byteLength} bytes`);
  
  try {
    // Update global state
    activeAudioTabId = tabId;
    
    // Convert audio data to base64
    const base64Audio = arrayBufferToBase64(audioData);
    
    // Create audio element in the tab
    await chrome.scripting.executeScript({
      target: { tabId },
      function: (audioSrc, hasCallback, isPaused) => {
        console.log('Creating audio element in page');
        
        // Create audio element
        const audioElement = document.createElement('audio');
        audioElement.id = 'simpereader-audio';
        audioElement.style.display = 'none';
        audioElement.src = `data:audio/mp3;base64,${audioSrc}`;
        
        // Set up event handlers with extra logging
        audioElement.onended = () => {
          console.log('Audio playback ended, dispatching event');
          document.dispatchEvent(new CustomEvent('simpleReaderAudioEnded'));
          
          // Double ensure the message is sent by also using setTimeout
          // This can help in cases where the event listener registration might have issues
          setTimeout(() => {
            console.log('Backup completion check - sending audioEnded message');
            try {
              chrome.runtime.sendMessage({
                action: 'audioEnded',
                tabId: chrome.runtime.id
              }).catch(e => console.error('Error sending backup audioEnded message:', e));
            } catch (e) {
              console.error('Error in backup completion handler:', e);
            }
          }, 300);
        };
        
        // Also add timeupdate handler as another fallback for completion detection
        // This can help if the ended event doesn't fire for some reason
        audioElement.addEventListener('timeupdate', function() {
          // If we're near the end of the audio (within 0.5 seconds)
          if (this.duration > 0 && 
              this.currentTime > 0 && 
              this.duration - this.currentTime < 0.5) {
            
            // Only do this once per audio element
            if (!this.hasTriggeredEndNearby) {
              console.log('Near audio end detected, preparing to signal completion');
              this.hasTriggeredEndNearby = true;
              
              // Set a timeout to check if the ended event is fired
              setTimeout(() => {
                // If still playing and very near the end, force an ended event
                if (!this.paused && this.duration - this.currentTime < 0.2) {
                  console.log('Forcing audio end event due to being near the end');
                  document.dispatchEvent(new CustomEvent('simpleReaderAudioEnded'));
                }
              }, 600);
            }
          }
        });
        
        audioElement.onerror = (e) => {
          console.error('Audio playback error:', e);
          document.dispatchEvent(new CustomEvent('simpleReaderAudioError', {
            detail: { error: e.message || 'Unknown audio error' }
          }));
        };
        
        // Remove any existing audio element
        const existingAudio = document.getElementById('simpereader-audio');
        if (existingAudio) {
          console.log('Removing existing audio element');
          existingAudio.pause();
          existingAudio.remove();
        }
        
        // Add to the document and play
        document.body.appendChild(audioElement);
        
        // Store reference globally for pause/resume
        window.simpleReaderAudio = audioElement;
        
        // Don't autoplay if paused state is active
        if (isPaused) {
          console.log('Audio created in paused state');
          return { success: true };
        }
        
        // Play with user interaction handling
        const playPromise = audioElement.play();
        if (playPromise) {
          playPromise
            .then(() => {
              console.log('Audio playback started successfully');
            })
            .catch(error => {
              console.error('Error playing audio:', error);
              
              // Create a play button if user interaction is needed
              if (error.name === 'NotAllowedError') {
                // Create a modal for play button if not already exists
                let modalContainer = document.getElementById('simpleReader-modal-container');
                
                if (!modalContainer) {
                  modalContainer = document.createElement('div');
                  modalContainer.id = 'simpleReader-modal-container';
                  modalContainer.style.cssText = `
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.7);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    z-index: 999999;
                  `;
                  document.body.appendChild(modalContainer);
                }
                
                // Clear existing content
                modalContainer.innerHTML = '';
                
                // Create play button modal
                const modal = document.createElement('div');
                modal.style.cssText = `
                  background-color: white;
                  border-radius: 8px;
                  padding: 20px;
                  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                  text-align: center;
                  max-width: 90%;
                  width: 400px;
                `;
                
                const title = document.createElement('h2');
                title.textContent = 'SimpleReader Audio';
                title.style.marginBottom = '15px';
                
                const message = document.createElement('p');
                message.textContent = 'Click the button below to start audio playback';
                message.style.marginBottom = '20px';
                
                const button = document.createElement('button');
                button.textContent = 'Play Audio';
                button.style.cssText = `
                  background-color: #4285f4;
                  color: white;
                  border: none;
                  padding: 10px 20px;
                  border-radius: 4px;
                  cursor: pointer;
                  font-size: 16px;
                `;
                
                button.onclick = () => {
                  audioElement.play()
                    .then(() => {
                      console.log('Audio playback started after user interaction');
                      modalContainer.remove();
                    })
                    .catch(err => {
                      console.error('Error playing after click:', err);
                      message.textContent = 'Failed to play audio: ' + err.message;
                      message.style.color = 'red';
                    });
                };
                
                modal.appendChild(title);
                modal.appendChild(message);
                modal.appendChild(button);
                modalContainer.appendChild(modal);
              }
            });
        }
        
        // Set up communication with background script
        if (hasCallback) {
          // Listen for audio ended event with additional logging
          const audioEndedHandler = function() {
            console.log('Audio ended event received, sending message to background script');
            // Notify background script that audio has ended
            chrome.runtime.sendMessage({
              action: 'audioEnded',
              tabId: chrome.runtime.id // Use runtime id as a proxy for tabId
            }).catch(e => console.error('Error sending audioEnded message:', e));
          };
          
          // Ensure we clean up old listeners to prevent duplicates
          document.removeEventListener('simpleReaderAudioEnded', audioEndedHandler);
          document.addEventListener('simpleReaderAudioEnded', audioEndedHandler);
          
          // Also set a backup timeout to check if the audio has finished
          // This helps if the ended event doesn't fire for some reason
          setTimeout(() => {
            if (window.simpleReaderAudio) {
              const audio = window.simpleReaderAudio;
              if (!audio.paused && audio.duration > 0) {
                // If we're very near the end or beyond the duration
                if (audio.currentTime >= audio.duration - 0.5 || 
                    audio.currentTime === 0) { // Sometimes currentTime resets at the end
                  console.log('Backup timeout check: Audio appears complete but event may not have fired');
                  document.dispatchEvent(new CustomEvent('simpleReaderAudioEnded'));
                }
              }
            }
          }, 60000); // Check after 1 minute
        }
        
        return { success: true };
      },
      args: [base64Audio, !!onComplete, audioState.isPaused]
    });
    
    // Create a listener for the audio completion if callback provided
    if (onComplete) {
      // Clear any existing listener first
      if (currentAudioEndedListener) {
        chrome.runtime.onMessage.removeListener(currentAudioEndedListener);
      }
      
      const audioEndedListener = (message, sender, sendResponse) => {
        if (message.action === 'audioEnded') {
          console.log('Received audioEnded message in background script');
          // Remove listener to prevent memory leaks
          chrome.runtime.onMessage.removeListener(audioEndedListener);
          currentAudioEndedListener = null;
          
          // Clear any completion check timeout
          if (sectionCompletionCheck) {
            clearTimeout(sectionCompletionCheck);
            sectionCompletionCheck = null;
          }
          
          // Execute the completion callback
          console.log('Executing completion callback for section');
          onComplete();
        }
      };
      
      // Store reference to current listener for later cleanup
      currentAudioEndedListener = audioEndedListener;
      
      // Add temporary listener
      chrome.runtime.onMessage.addListener(audioEndedListener);
      
      // Set a safety timeout to ensure the callback is eventually called
      // This helps if for some reason the audio ends but the message doesn't reach here
      if (!globalSectionTimeout) {
        globalSectionTimeout = setTimeout(() => {
          console.log('Global timeout check: Ensuring section completion');
          if (activeAudioTabId === tabId) {
            // If we're still on this section and tab, try to move forward
            onComplete();
          }
          globalSectionTimeout = null;
        }, 3 * 60 * 1000); // 3 minute maximum per section
      }
    }
    
    await createOrUpdateModal(tabId, 'playing', null, tabId);
    console.log('Audio playback started');
    
  } catch (error) {
    console.error('Error playing audio in tab:', error);
    activeAudioTabId = null;
    
    // Even on error, try to continue to the next section
    if (onComplete) {
      setTimeout(onComplete, 1000);
    }
    
    throw error;
  }
}

// Function to pre-fetch the next section's audio with improved error handling
async function prefetchNextSection(nextIndex) {
  if (nextIndex >= audioState.totalSections || isFetchingNext) {
    return; // No more sections or already fetching
  }
  
  isFetchingNext = true;
  const nextSection = sectionQueue[nextIndex];
  
  try {
    console.log(`Pre-fetching section ${nextIndex + 1}/${audioState.totalSections}`);
    
    // Skip conversion for heading-only sections
    if (nextSection.type === 'heading') {
      audioQueue.push({
        sectionIndex: nextIndex,
        title: nextSection.title,
        audioData: null,
        type: 'heading'
      });
    } else {
      // Convert the next section to speech
      const audioData = await convertTextToSpeech(nextSection.content, nextSection.title);
      
      // Add to queue
      audioQueue.push({
        sectionIndex: nextIndex,
        title: nextSection.title,
        audioData,
        type: 'content'
      });
    }
    
    isFetchingNext = false;
    
    // Continue pre-fetching if more sections exist
    if (nextIndex + 1 < audioState.totalSections) {
      prefetchNextSection(nextIndex + 1);
    }
  } catch (error) {
    console.error(`Error pre-fetching section ${nextIndex + 1}:`, error);
    isFetchingNext = false;
    
    // Add error placeholder to queue so we can still attempt to play
    audioQueue.push({
      sectionIndex: nextIndex,
      title: nextSection.title,
      error: error.message,
      type: 'error'
    });
    
    // Still try to continue with next sections
    setTimeout(() => {
      if (nextIndex + 1 < audioState.totalSections) {
        prefetchNextSection(nextIndex + 1);
      }
    }, 1000);
  }
}

// Pause audio playback - fixed implementation
async function pauseAudio(tabId) {
  console.log('Pausing audio in tab', tabId);
  
  if (!activeAudioTabId) {
    return { success: false, reason: 'No audio playing' };
  }
  
  try {
    // Update global state
    audioState.isPaused = true;
    
    // Get the correct tab ID
    const targetTabId = tabId || activeAudioTabId;
    
    // Add a small delay to ensure UI updates before we try to pause
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Execute pause in the tab with more debugging
    const result = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      function: () => {
        try {
          // Debug log what we find
          console.log('Audio element exists:', !!window.simpleReaderAudio);
          
          if (window.simpleReaderAudio) {
            console.log('Pausing audio element');
            window.simpleReaderAudio.pause();
            
            // Verify it worked
            console.log('Audio is now paused:', window.simpleReaderAudio.paused);
            
            return { 
              success: true,
              debug: { 
                elementExists: true,
                isPaused: window.simpleReaderAudio.paused 
              }
            };
          } else {
            // Try to find it by ID as fallback
            const audioEl = document.getElementById('simpereader-audio');
            if (audioEl) {
              console.log('Found audio by ID instead of window property');
              audioEl.pause();
              window.simpleReaderAudio = audioEl; // Fix the reference
              return { 
                success: true,
                debug: { foundById: true, isPaused: audioEl.paused }
              };
            }
            
            console.warn('No audio element found to pause');
            return { 
              success: false, 
              reason: 'No audio element found',
              debug: { elementExists: false } 
            };
          }
        } catch (err) {
          console.error('Error in pause content script:', err);
          return { 
            success: false, 
            error: err.toString(),
            debug: { errorOccurred: true }
          };
        }
      }
    });
    
    console.log('Pause result:', result[0].result);
    
    // Update the UI to show paused state
    await createOrUpdateModal(targetTabId, 'playing', null, targetTabId);
    
    return result[0].result;
  } catch (error) {
    console.error('Error pausing audio:', error);
    return { success: false, error: error.message };
  }
}

// Resume audio playback - fixed implementation
async function resumeAudio(tabId) {
  console.log('Resuming audio in tab', tabId);
  
  if (!activeAudioTabId) {
    return { success: false, reason: 'No audio to resume' };
  }
  
  try {
    // Update global state
    audioState.isPaused = false;
    
    // Get the correct tab ID
    const targetTabId = tabId || activeAudioTabId;
    
    // Add a small delay to ensure UI updates before we try to resume
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Execute resume in the tab with more debugging
    const result = await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      function: () => {
        try {
          console.log('Audio element exists:', !!window.simpleReaderAudio);
          
          if (window.simpleReaderAudio) {
            console.log('Resuming audio element');
            const playPromise = window.simpleReaderAudio.play();
            
            if (playPromise) {
              playPromise.catch(error => {
                console.error('Error resuming playback:', error);
              });
            }
            
            return { 
              success: true,
              debug: { elementExists: true }
            };
          } else {
            // Try to find it by ID as fallback
            const audioEl = document.getElementById('simpereader-audio');
            if (audioEl) {
              console.log('Found audio by ID instead of window property');
              audioEl.play().catch(e => console.error('Play error:', e));
              window.simpleReaderAudio = audioEl; // Fix the reference
              return { 
                success: true,
                debug: { foundById: true }
              };
            }
            
            console.warn('No audio element found to resume');
            return { 
              success: false, 
              reason: 'No audio element found',
              debug: { elementExists: false }
            };
          }
        } catch (err) {
          console.error('Error in resume content script:', err);
          return { 
            success: false, 
            error: err.toString(),
            debug: { errorOccurred: true }
          };
        }
      }
    });
    
    console.log('Resume result:', result[0].result);
    
    // Update the UI to show playing state
    await createOrUpdateModal(targetTabId, 'playing', null, targetTabId);
    
    return result[0].result;
  } catch (error) {
    console.error('Error resuming audio:', error);
    return { success: false, error: error.message };
  }
}

// Stop audio - fixed implementation
async function stopAudio(tabId) {
  console.log('Stopping audio in tab', tabId);
  
  // If no active audio, consider it a success
  if (!activeAudioTabId) {
    console.log('No active audio to stop');
    return { success: true };
  }
  
  try {
    // Get the current active tab before resetting state
    const currentActiveTab = tabId || activeAudioTabId;
    
    // Reset global state
    activeAudioTabId = null;
    audioState = {
      currentSection: 0,
      totalSections: 0,
      isPaused: false
    };
    
    // Add a small delay to ensure UI updates before we try to stop
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Execute in the tab to stop audio with more debugging
    const result = await chrome.scripting.executeScript({
      target: { tabId: currentActiveTab },
      function: () => {
        try {
          console.log('Looking for audio to stop');
          
          let audioStopped = false;
          // Try window property first
          if (window.simpleReaderAudio) {
            console.log('Stopping audio via window property');
            window.simpleReaderAudio.pause();
            window.simpleReaderAudio.src = '';
            window.simpleReaderAudio = null;
            audioStopped = true;
          }
          
          // Also try by ID as fallback or extra cleanup
          const audioEl = document.getElementById('simpereader-audio');
          if (audioEl) {
            console.log('Stopping audio element found by ID');
            audioEl.pause();
            audioEl.src = '';
            audioEl.remove();
            audioStopped = true;
          }
          
          // Clean up any UI elements
          const playPrompt = document.getElementById('simpleReader-play-prompt');
          if (playPrompt) {
            playPrompt.remove();
          }
          
          return { 
            success: true, 
            debug: { 
              audioElementStopped: audioStopped,
              elementFoundByProperty: !!window.simpleReaderAudio,
              elementFoundById: !!audioEl
            }
          };
        } catch (err) {
          console.error('Error in stop content script:', err);
          return { 
            success: false, 
            error: err.toString(),
            debug: { errorOccurred: true }
          };
        }
      }
    });
    
    console.log('Stop result:', result[0].result);
    
    // Update UI to show ready state
    await createOrUpdateModal(currentActiveTab, 'ready', null, currentActiveTab);
    
    console.log('Audio stopped successfully');
    return result[0].result;
  } catch (error) {
    console.error('Error stopping audio:', error);
    return { success: false, error: error.message };
  }
}

// Read the current page
async function readPage(tabId) {
  console.log(`Reading page for tab ${tabId}`);
  try {
    // Stop any currently playing audio first
    await stopAudio(tabId).catch((error) => {
      console.log('No previous audio to stop:', error.message);
    });
    
    // Show the modal with reading status
    await createOrUpdateModal(tabId, 'reading', 'Extracting article content...', tabId);
    
    // Extract content from the page
    const article = await extractContentFromPage(tabId);
    
    if (!article || !article.content || article.content.trim().length === 0) {
      await createOrUpdateModal(tabId, 'error', 'No content could be extracted from this page', tabId);
      throw new Error('No content could be extracted from this page');
    }
    
    console.log(`Extracted article content, length: ${article.content.length} characters`);
    
    // Update UI to show we're processing the audio
    await createOrUpdateModal(tabId, 'reading', 'Converting article to speech...', tabId);
    
    // Convert the entire article to speech
    const audioData = await convertTextToSpeech(article.content, article.title);
    
    // Set active tab ID
    activeAudioTabId = tabId;
    
    // Update state
    audioState = {
      currentSection: 1,
      totalSections: 1,
      isPaused: false
    };
    
    // Play the audio
    await playAudio(tabId, audioData);
    
    return { success: true };
  } catch (error) {
    console.error('Error reading page:', error);
    await createOrUpdateModal(tabId, 'error', error.message || 'Failed to read page', tabId);
    return { error: error.message || 'Failed to read page' };
  }
}

// Simple audio playback function
async function playAudio(tabId, audioData) {
  console.log(`Playing audio in tab ${tabId}, size: ${audioData.byteLength} bytes`);
  
  try {
    // Convert audio to base64
    const base64Audio = arrayBufferToBase64(audioData);
    
    // Create and play the audio in tab
    await chrome.scripting.executeScript({
      target: { tabId },
      function: (audioSrc, isPaused) => {
        // Create audio element
        const audioElement = document.createElement('audio');
        audioElement.id = 'simpereader-audio';
        audioElement.style.display = 'none';
        audioElement.src = `data:audio/mp3;base64,${audioSrc}`;
        
        // Simple ended event handler
        audioElement.onended = () => {
          console.log('Audio playback ended');
          chrome.runtime.sendMessage({ action: 'audioEnded' });
        };
        
        // Remove any existing audio element
        const existingAudio = document.getElementById('simpereader-audio');
        if (existingAudio) {
          existingAudio.pause();
          existingAudio.remove();
        }
        
        // Add to document
        document.body.appendChild(audioElement);
        
        // Store for pause/resume - IMPORTANT: must be in window to work
        window.simpleReaderAudio = audioElement;
        
        // Don't play if paused state
        if (isPaused) return;
        
        // Play the audio
        const playPromise = audioElement.play();
        if (playPromise) {
          playPromise.catch(error => {
            console.error('Error playing audio:', error);
            
            // Create play button for autoplay blocked scenarios
            if (error.name === 'NotAllowedError') {
              // Create modal for user interaction
              const container = document.createElement('div');
              container.id = 'simpleReader-play-prompt';
              container.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 999999;
              `;
              
              const modal = document.createElement('div');
              modal.style.cssText = `
                background-color: white;
                border-radius: 8px;
                padding: 20px;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                text-align: center;
                max-width: 400px;
              `;
              
              const title = document.createElement('h2');
              title.textContent = 'SimpleReader Audio';
              title.style.marginBottom = '15px';
              
              const message = document.createElement('p');
              message.textContent = 'Click to enable audio playback';
              message.style.marginBottom = '20px';
              
              const button = document.createElement('button');
              button.textContent = 'Play Audio';
              button.style.cssText = `
                background-color: #3a86ff;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 4px;
                cursor: pointer;
              `;
              
              button.onclick = () => {
                audioElement.play()
                  .then(() => container.remove())
                  .catch(err => {
                    message.textContent = 'Failed to play audio: ' + err.message;
                    message.style.color = 'red';
                  });
              };
              
              modal.appendChild(title);
              modal.appendChild(message);
              modal.appendChild(button);
              container.appendChild(modal);
              document.body.appendChild(container);
            }
          });
        }
      },
      args: [base64Audio, audioState.isPaused]
    });
    
    // Listen for audio completion
    chrome.runtime.onMessage.addListener(function audioEndedListener(message) {
      if (message.action === 'audioEnded') {
        console.log('Audio playback completed');
        chrome.runtime.onMessage.removeListener(audioEndedListener);
        
        // Update UI to show completed state
        createOrUpdateModal(tabId, 'complete', 'Finished reading the page', tabId).catch(
          error => console.error('Error updating modal after completion:', error)
        );
      }
    });
    
    // Update UI to show playing state - fixed by removing document.title reference
    await createOrUpdateModal(tabId, 'playing', 'Playing article...', tabId);
    
  } catch (error) {
    console.error('Error playing audio:', error);
    await createOrUpdateModal(tabId, 'error', `Error: ${error.message}`, tabId);
    throw error;
  }
}

// Helper function to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  
  return btoa(binary);
} 