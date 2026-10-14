// endereço antigo: remove o service worker e manda para o novo endereço
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.registration.unregister()));
