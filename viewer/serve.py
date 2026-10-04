#!/usr/bin/env python3
"""
Chess Archive Viewer — local development server
Run from the repo root:  python viewer/serve.py
Then open:               http://localhost:8000/viewer/viewer.html
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT    = 8000
VIEWER  = "/viewer/viewer.html"

# Always serve from the repo root (one level up from viewer/)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT  = os.path.dirname(SCRIPT_DIR)
os.chdir(REPO_ROOT)

class Handler(http.server.SimpleHTTPRequestHandler):
    # Silence request logging — comment out to see all requests
    def log_message(self, fmt, *args):
        pass

    # Correct MIME types for SVG and PGN
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".svg": "image/svg+xml",
        ".pgn": "text/plain; charset=utf-8",
        ".json": "application/json",
        ".js":  "application/javascript",
        ".css": "text/css",
        ".wasm": "application/wasm",
    }

print(f"Serving from: {REPO_ROOT}")
print(f"Open:         http://localhost:{PORT}{VIEWER}")
print(f"Press Ctrl+C to stop.\n")

webbrowser.open(f"http://localhost:{PORT}{VIEWER}")

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
