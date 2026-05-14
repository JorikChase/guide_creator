# Krutart Guide Creator: Analysis and Context Summary

This document provides a comprehensive overview of the `krutart-guide-creator` Electron application to facilitate future planning and feature implementation.

## Project Overview
The **Krutart Guide Creator** is a specialized Electron-based desktop application designed for the Krutart animation pipeline. Its primary function is to automate the splitting of "Guide" videos (typically exported from Adobe Premiere Pro with chapter markers) into individual shot clips, scaled to 540p, with standardized prefixes, suffixes, and metadata, while keeping a cloud-based production sheet in sync.

## Core Technical Architecture
- **Framework**: Electron (Main and Renderer process model).
- **Video Processing Engine**: FFmpeg and FFprobe (bundled in `/bin` or expected in system path).
- **Data Source/Sync**: Google Sheets (via CSV export for reading and a Google Apps Script web app for posting).
- **Communication**: IPC (Inter-Process Communication) via `preload.js` bridge.

---

## Component Analysis

### 1. Main Process (`main.js`)
Handles the heavy lifting and system interactions:
- **Video Analysis**: Spawns `ffprobe` to extract chapter markers and video metadata (framerate, duration).
- **Google Sheets Integration**:
    - **Fetch**: Downloads CSV from a specific Google Sheet URL to map Chapter IDs to target shot names and file paths.
    - **Update**: Posts duration data (seconds and frames) and guide version numbers back to a Google Apps Script endpoint.
- **FFmpeg Orchestration**:
    - Manages complex filter graphs for scaling (960x540), padding (10-frame prefix/suffix), and All-Intra H.264 encoding.
    - Handles "Pause", "Resume", and "Stop" logic for long-running batches.
- **File System**: Manages directory creation and versioned filename generation (e.g., `shot_name-v001.mp4`).

### 2. Renderer Process (`renderer.js`)
Manages the user interface and application state:
- **UI State**: Tracks file paths, chapter selections, and processing status.
- **Interaction**: Handles Drag-and-Drop, file browsing, and toggle controls for Debug Mode.
- **Dynamic UI**: Renders a list of detected chapters with "Select All" functionality and live status updates (Ready -> Processing -> Done).

### 3. IPC Bridge (`preload.js`)
The secure gateway between the UI and the system, exposing specific APIs like `analyzeVideos`, `processVideos`, and `fetchSheetData`.

### 4. Visual Language (`style.css`)
- **Branding**: Uses "Soin Sans" font with a high-contrast palette (Yellow: `#F3E400`, Red: `#E32322`).
- **UX**: Implements a "Neubrutalist" style with hard shadows and snap-scrolling sections.

---

## Data Flow & Workflow
1. **Input**: User drops `.mov` files into the app.
2. **Analysis**: App extracts chapter titles.
3. **Mapping**: App fetches the Google Sheet mapping. If a Match is found, the chapter is renamed to the "Guide Name" from the sheet; otherwise, it remains as "Unmatched".
4. **Execution**: FFmpeg processes each selected chapter:
    - Extracts start/end points.
    - Generates 10-frame still frames for start/end.
    - Concatenates Prefix + Main + Suffix.
    - Outputs to the path specified in the Google Sheet.
5. **Sync**: On completion of each clip, it reports the exact frame count and version back to the Google Sheet.

---

## Known Logic / Hotspots
- **Framerate Handling**: Includes "Sanity Checks" for frame rate to avoid common calculation bugs.
- **Suffix Generation**: Includes a retry mechanism for suffix frames to handle cases where FFmpeg might fail to seek to the very last frame.
- **Path Sanitization**: Heavily sanitizes names to be filesystem-safe.

## New Feature Planning Skeleton
When planning a new feature, use this structure to ensure alignment:

### [Feature Name]
- **Goal**: [Description of what the feature achieves]
- **Impacted Components**:
    - `main.js`: [Changes to FFmpeg args, Sheet API, or state logic]
    - `renderer.js`: [New UI elements or listeners]
    - `preload.js`: [New IPC channels if needed]
    - `style.css`: [New design tokens or component styles]
- **Verification Plan**: [How to test in Dev vs Prod modes]
