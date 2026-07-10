docker stop switchboard
docker rm switchboard
docker build -t switchboard .
docker run -d --name switchboard -p 127.0.0.1:20128:20128 --env-file .env -v switchboard-data:/app/data switchboard
