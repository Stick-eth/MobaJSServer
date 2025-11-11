# MobaJSServer

## Configuration de l'environnement

1. Copier `.env.example` en `.env` à la racine du serveur.
2. Compléter les variables ci-dessous selon votre déploiement :
	- `PORT` : port d'écoute du serveur Socket.IO (par défaut `3000`).
	- `CLIENT_URL` : URL autorisée pour le client (ex. `http://localhost:5173` ou `https://mon-domaine`).

`CLIENT_URL` accepte une seule URL ou une liste séparée par des virgules si plusieurs origines doivent être autorisées.

## Lancement

```bash
npm install
node server.js
```