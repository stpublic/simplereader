# SimpleReader - OpenAI Text-to-Speech Chrome Extension

A lightweight Chrome extension that reads web page content aloud using OpenAI's Text-to-Speech (TTS) API. SimpleReader intelligently extracts the main content from web pages and converts it to natural-sounding speech.

## Features

- **Smart Content Extraction**: Automatically identifies and extracts the main content from web pages
- **Natural Text-to-Speech**: Uses OpenAI's high-quality TTS API for lifelike speech
- **In-Page Modal Interface**: Clean, non-intrusive UI that appears directly on the webpage
- **Voice Selection**: Choose from multiple voice options (Alloy, Echo, Fable, Onyx, Nova, Shimmer)
- **Speed Control**: Adjust reading speed from 0.25x to 4.0x
- **Model Options**: Select between standard (tts-1) or high-definition (tts-1-hd) audio quality

## Installation

### From Source

1. Clone this repository:
   ```
   git clone https://github.com/yourusername/simplereader.git
   ```

2. Open Chrome and navigate to `chrome://extensions/`

3. Enable "Developer mode" by toggling the switch in the top-right corner

4. Click "Load unpacked" and select the cloned repository folder

### Configuration

1. After installation, click the extension icon in your toolbar
2. If you haven't set up an API key, the options page will open automatically
3. Enter your OpenAI API key ([Get one here](https://platform.openai.com/api-keys))
4. Configure your preferred voice, speed, and model quality
5. Click "Save Settings"

## Usage

1. Navigate to any web page with content you want to hear
2. Click the SimpleReader icon in your browser toolbar
3. A modal will appear on the page with a "Read Page" button
4. Click "Read Page" to start reading the content
5. Use the "Stop" button to stop playback at any time
6. The modal can be closed using the X button in the top-right corner

## Privacy & Cost Considerations

- Your OpenAI API key is stored locally in your browser
- Text-to-speech conversion happens through the OpenAI API and incurs costs:
  - Standard model (tts-1): $0.015 per 1,000 characters
  - HD model (tts-1-hd): $0.030 per 1,000 characters
- The extension limits the amount of text converted to control costs

## Development

The extension consists of two main components:

1. **Background Script**: Handles extension button clicks, API communication, content extraction, and the in-page modal UI
2. **Options Page**: Configuration interface for API key and TTS settings

To modify the extension:
1. Make your changes to the relevant files
2. Reload the extension in `chrome://extensions/`

## Troubleshooting

If the extension is not reading pages correctly:

1. Check the browser console for any error messages (press F12 to open Developer Tools)
2. Verify your API key is correctly entered in the extension settings
3. Make sure you're on a page with readable content
4. Try refreshing the page and trying again

## License

[MIT License](LICENSE)

## Acknowledgements

- [OpenAI TTS API](https://platform.openai.com/docs/guides/text-to-speech)
- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/) 