# Slack Active Users Overlay

A Greasemonkey userscript that adds a right-side overlay in Slack to visualize active users.  
It logs DOM presence every minute and provides a hover panel with a **10×24 heatmap** and "last seen" info.

## Features
- Right-side overlay with compact user list
- 1-minute DOM presence logging
- Mini timeline bars (last 12 hours)
- Tooltip with 10×24 daily/hourly heatmap
- Filters: Active, Inactive, Vacation 🌴, All
- Fixed-width status indicators
- Optimized for Slack **Dark Mode**

## Installation
1. Install [Greasemonkey](https://addons.mozilla.org/firefox/addon/greasemonkey/) (Firefox)  
   or another userscript manager of your choice.
2. Add the script: [slack-active-users-overlay.user.js](./slack-active-users-overlay.user.js)
3. Open [Slack Web](https://app.slack.com) — the overlay will appear on the right side.

## Usage
- Hover a user in the overlay or in the Slack sidebar to see the heatmap tooltip.
- Use the search box to filter by name.
- Use filter buttons to show Active, Inactive, Vacation 🌴, or All.
- Export history as JSON or clear stored data using the header buttons.

## Author
Developed by **Sven A. Schäfer**  
License: MIT
