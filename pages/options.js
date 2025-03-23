/**
 * Options script for SimpleReader
 * Handles settings management
 */

// DOM elements
const apiKeyInput = document.getElementById('api-key');
const toggleApiKeyButton = document.getElementById('toggle-api-key');
const verifyApiKeyButton = document.getElementById('verify-api-key');
const keyVerificationResult = document.getElementById('key-verification-result');

// Model elements
const modelGpt4oRadio = document.getElementById('model-gpt4o');
const modelTts1106Radio = document.getElementById('model-tts1106');
const modelCardGpt4o = document.getElementById('model-card-gpt4o');
const modelCardTts1106 = document.getElementById('model-card-tts1106');

// Other settings elements
const defaultVoiceSelect = document.getElementById('default-voice');
const defaultToneSelect = document.getElementById('default-tone');
const defaultSpeedInput = document.getElementById('default-speed');
const toneContainer = document.getElementById('tone-container');
const speedContainer = document.getElementById('speed-container');

const saveButton = document.getElementById('save-button');
const resetSettingsLink = document.getElementById('reset-settings');
const statusMessage = document.getElementById('status-message');

// Default settings - updated to use latest models only
const DEFAULT_SETTINGS = {
  voice: 'coral', // Default to more expressive voice
  model: 'gpt-4o-mini-tts',
  speed: 1.0,
  tone: 'natural',
  apiKey: ''
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  setupListeners();
});

// Load settings from storage
function loadSettings() {
  chrome.storage.local.get('settings', (result) => {
    const settings = result.settings || DEFAULT_SETTINGS;
    
    // Apply settings to UI
    apiKeyInput.value = settings.apiKey || '';
    defaultVoiceSelect.value = settings.voice || 'coral';
    defaultSpeedInput.value = settings.speed || 1.0;
    
    if (defaultToneSelect) {
      defaultToneSelect.value = settings.tone || 'natural';
    }
    
    // Force latest model if not already using one
    let model = settings.model;
    if (!['gpt-4o-mini-tts', 'tts-1-1106'].includes(model)) {
      model = DEFAULT_SETTINGS.model;
    }
    
    // Clear all model selections
    [modelCardGpt4o, modelCardTts1106].forEach(card => {
      if (card) card.classList.remove('selected');
    });
    
    // Set model radio button
    if (model === 'tts-1-1106') {
      if (modelTts1106Radio) modelTts1106Radio.checked = true;
      if (modelCardTts1106) modelCardTts1106.classList.add('selected');
    } else {
      // Default to gpt-4o-mini-tts
      if (modelGpt4oRadio) modelGpt4oRadio.checked = true;
      if (modelCardGpt4o) modelCardGpt4o.classList.add('selected');
    }
    
    // Show/hide tone options based on model
    updateFormVisibility(model);
  });
}

// Update UI based on model selection
function updateFormVisibility(model) {
  // Speed is only available for tts-1-1106
  if (speedContainer) {
    if (model === 'tts-1-1106') {
      speedContainer.style.display = 'block';
    } else {
      speedContainer.style.display = 'none';
    }
  }
}

// Save settings to storage
function saveSettings() {
  // Get selected model
  let model = 'gpt-4o-mini-tts'; // default
  if (modelTts1106Radio && modelTts1106Radio.checked) model = 'tts-1-1106';
  
  // Get values from UI
  const apiKey = apiKeyInput.value.trim();
  const voice = defaultVoiceSelect.value;
  const speed = parseFloat(defaultSpeedInput.value);
  const tone = defaultToneSelect ? defaultToneSelect.value : 'natural';
  
  // Validate speed range
  const validatedSpeed = Math.min(Math.max(speed, 0.25), 4.0);
  
  // Create settings object
  const settings = {
    apiKey,
    voice,
    speed: validatedSpeed,
    model,
    tone
  };
  
  // Save to storage
  chrome.storage.local.set({ settings }, () => {
    showStatus('Settings saved successfully!', 'success');
  });
}

// Verify API key with OpenAI
async function verifyApiKey() {
  const apiKey = apiKeyInput.value.trim();
  
  if (!apiKey) {
    keyVerificationResult.textContent = 'Please enter an API key first';
    keyVerificationResult.style.color = '#d93025';
    return;
  }
  
  // Show loading state
  verifyApiKeyButton.textContent = 'Verifying...';
  verifyApiKeyButton.disabled = true;
  keyVerificationResult.textContent = 'Checking API key...';
  keyVerificationResult.style.color = '#5f6368';
  
  try {
    // OpenAI TTS API endpoint
    const apiUrl = 'https://api.openai.com/v1/audio/speech';
    
    // Simple request to test the API key
    const testPayload = {
      model: 'tts-1',
      input: 'This is a test',
      voice: 'alloy',
      response_format: 'mp3'
    };
    
    // Set a timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(testPayload),
      signal: controller.signal
    });
    
    // Clear the timeout
    clearTimeout(timeoutId);
    
    if (response.ok) {
      keyVerificationResult.textContent = 'API key is valid! ✓';
      keyVerificationResult.style.color = '#0f9d58';
    } else {
      // Try to get error details
      let errorMessage = 'Invalid API key';
      
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = errorData.error.message || errorData.error.type;
        }
      } catch (e) {
        // If we can't parse JSON, use status text
        errorMessage = `Error (${response.status}): ${response.statusText}`;
      }
      
      keyVerificationResult.textContent = errorMessage;
      keyVerificationResult.style.color = '#d93025';
    }
  } catch (error) {
    // Handle network errors, timeouts, etc.
    if (error.name === 'AbortError') {
      keyVerificationResult.textContent = 'Request timed out. Please check your connection.';
    } else {
      keyVerificationResult.textContent = `Error: ${error.message}`;
    }
    keyVerificationResult.style.color = '#d93025';
  }
  
  // Reset button
  verifyApiKeyButton.textContent = 'Verify';
  verifyApiKeyButton.disabled = false;
}

// Show status message
function showStatus(message, type = 'success') {
  statusMessage.textContent = message;
  statusMessage.className = `status ${type}`;
  statusMessage.style.display = 'block';
  
  // Auto hide after 3 seconds
  setTimeout(() => {
    statusMessage.style.display = 'none';
  }, 3000);
}

// Reset settings to defaults
function resetSettings() {
  if (confirm('Are you sure you want to reset all settings to default values?')) {
    chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => {
      loadSettings();
      showStatus('Settings reset to defaults', 'success');
    });
  }
}

// Set up event listeners
function setupListeners() {
  // Model card selection
  if (modelCardGpt4o) {
    modelCardGpt4o.addEventListener('click', () => {
      modelGpt4oRadio.checked = true;
      updateModelSelection('gpt-4o-mini-tts');
    });
  }
  
  if (modelCardTts1106) {
    modelCardTts1106.addEventListener('click', () => {
      modelTts1106Radio.checked = true;
      updateModelSelection('tts-1-1106');
    });
  }
  
  // Direct radio button changes
  [modelGpt4oRadio, modelTts1106Radio].forEach(radio => {
    if (radio) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          updateModelSelection(radio.value);
        }
      });
    }
  });
  
  // Toggle API key visibility
  toggleApiKeyButton.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleApiKeyButton.textContent = '🔒';
    } else {
      apiKeyInput.type = 'password';
      toggleApiKeyButton.textContent = '👁️';
    }
  });
  
  // Verify API key
  verifyApiKeyButton.addEventListener('click', verifyApiKey);
  
  // Save settings
  saveButton.addEventListener('click', saveSettings);
  
  // Reset settings
  resetSettingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    resetSettings();
  });
}

// Update model selection UI and form visibility
function updateModelSelection(model) {
  // Update model cards
  [
    { card: modelCardGpt4o, model: 'gpt-4o-mini-tts' },
    { card: modelCardTts1106, model: 'tts-1-1106' }
  ].forEach(item => {
    if (item.card) {
      if (model === item.model) {
        item.card.classList.add('selected');
      } else {
        item.card.classList.remove('selected');
      }
    }
  });
  
  // Update form visibility
  updateFormVisibility(model);
} 