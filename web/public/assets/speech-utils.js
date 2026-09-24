/**
 * Speech utilities for formatting terminal output for TTS
 */

const SpeechUtils = {
  /**
   * Extract meaningful content from terminal output
   * Strips ANSI codes, filters noise, summarizes for speech
   */
  formatForSpeech(terminalOutput, verbosity = 'brief') {
    if (!terminalOutput || terminalOutput.trim().length === 0) {
      return 'No output available.';
    }

    // Strip ANSI escape codes
    let cleaned = this._stripAnsi(terminalOutput);

    // Remove empty lines
    let lines = cleaned.split('\n').filter(line => line.trim().length > 0);

    if (lines.length === 0) {
      return 'The terminal is empty.';
    }

    // Brief mode: summarize
    if (verbosity === 'brief') {
      return this._summarize(lines);
    }

    // Detailed mode: read more content
    return this._formatDetailed(lines);
  },

  _stripAnsi(text) {
    // Remove ANSI escape sequences
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
               .replace(/\x1b\][0-9];[^\x07]*\x07/g, '');
  },

  _summarize(lines) {
    // Look for key indicators
    const lastLine = lines[lines.length - 1];

    // Check for common status patterns
    if (/✓|✔|success|passed|complete/i.test(lastLine)) {
      return this._extractSuccess(lines);
    }

    if (/✗|✘|error|failed|fatal/i.test(lastLine)) {
      return this._extractError(lines);
    }

    if (/waiting|idle|done|finished/i.test(lastLine)) {
      return this._extractStatus(lines);
    }

    if (/\$|%|>/.test(lastLine)) {
      return 'Ready for input.';
    }

    // Default: read last few lines
    const summary = lines.slice(-3).join('. ');
    return this._cleanForSpeech(summary);
  },

  _extractSuccess(lines) {
    // Find test results
    const testMatch = lines.join('\n').match(/(\d+)\s*(?:tests?)?\s*passed/i);
    if (testMatch) {
      return `Tests passed. ${testMatch[1]} tests successful.`;
    }

    // Find build status
    if (/build.*success/i.test(lines.join('\n'))) {
      return 'Build completed successfully.';
    }

    // Generic success
    return 'Task completed successfully.';
  },

  _extractError(lines) {
    // Find the actual error message
    const errorLines = lines.filter(line =>
      /error|failed|fatal|exception/i.test(line)
    );

    if (errorLines.length > 0) {
      const firstError = this._cleanForSpeech(errorLines[0]);
      return `Error: ${firstError}`;
    }

    return 'An error occurred. Check the terminal for details.';
  },

  _extractStatus(lines) {
    const lastLine = lines[lines.length - 1];
    return this._cleanForSpeech(lastLine);
  },

  _formatDetailed(lines) {
    // Read last 5 meaningful lines
    const relevant = lines.slice(-5);
    const text = relevant.map(line => this._cleanForSpeech(line)).join('. ');
    return text;
  },

  _cleanForSpeech(text) {
    return text
      // Remove file paths that are too long
      .replace(/\/[^\s]{30,}/g, 'file path')
      // Remove URLs
      .replace(/https?:\/\/[^\s]+/g, 'URL')
      // Remove excessive whitespace
      .replace(/\s+/g, ' ')
      // Remove special characters that sound weird
      .replace(/[│─┌┐└┘├┤┬┴┼]/g, '')
      .replace(/[▶▸►▷]/g, '')
      // Trim
      .trim();
  },

  /**
   * Format session status for speech
   */
  formatSessionStatus(session) {
    if (!session) return 'No session information available.';

    const parts = [];

    // Title
    if (session.title) {
      parts.push(`Session ${session.title}`);
    }

    // Status
    if (session.status) {
      switch (session.status) {
        case 'working':
          parts.push('is working');
          break;
        case 'idle':
          parts.push('is idle');
          break;
        case 'attention':
          parts.push('needs input');
          break;
        case 'stuck':
          parts.push('appears stuck');
          break;
        case 'done':
          parts.push('is done');
          break;
        default:
          parts.push(`status ${session.status}`);
      }
    }

    // Context
    if (session.context !== undefined) {
      parts.push(`at ${session.context}% context`);
    }

    return parts.join(' ');
  },

  /**
   * Format fleet status for speech
   */
  formatFleetStatus(fleet) {
    if (!fleet || !fleet.sessions) {
      return 'No fleet information available.';
    }

    const total = fleet.sessions.length;
    const working = fleet.sessions.filter(s => s.status === 'working').length;
    const needInput = fleet.sessions.filter(s => s.status === 'attention').length;
    const stuck = fleet.sessions.filter(s => s.status === 'stuck').length;

    const parts = [`${total} sessions`];

    if (working > 0) parts.push(`${working} working`);
    if (needInput > 0) parts.push(`${needInput} need input`);
    if (stuck > 0) parts.push(`${stuck} stuck`);

    return parts.join(', ');
  },

  /**
   * List available voice commands
   */
  getHelpText() {
    return `Available commands:
      Read output.
      What's happening.
      Switch to tab number.
      Type text.
      Run command.
      Send enter.
      Interrupt.
      Continue.
      Clear screen.
      Next tab.
      Previous tab.
      Scroll up.
      Scroll down.`;
  }
};

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SpeechUtils;
}
