# HTTPS server for the update check: serves <work>/<name in <work>/live> on port 8443, with the cache
# header GitHub Pages sends (browsers may keep files 10 minutes). usage: python3 serve.py <work>
import http.server, ssl, os, sys, time
BASE = os.path.abspath(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        root = os.path.join(BASE, open(os.path.join(BASE, 'live')).read().strip())
        self.directory = root
        return super().translate_path(path)
    def end_headers(self):
        self.send_header('Cache-Control', 'max-age=600')
        super().end_headers()
    def do_GET(self):
        # always the full file: Python answers by date (to the second), and the copies here are made
        # seconds apart; GitHub Pages compares contents instead
        del self.headers['If-Modified-Since']; del self.headers['If-None-Match']
        if self.path.startswith('/data/pieces.glb'):
            while os.path.exists(os.path.join(BASE, 'hold')):   # the update waits until the test lets it go
                time.sleep(0.1)
        with open(os.path.join(BASE, 'log.txt'), 'a') as f:
            f.write(f"{time.strftime('%H:%M:%S')} {open(os.path.join(BASE,'live')).read().strip()} {self.path} cc={self.headers.get('Cache-Control')}\n")
        super().do_GET()
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8443), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(os.path.join(BASE, 'cert.pem'), os.path.join(BASE, 'key.pem'))
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
