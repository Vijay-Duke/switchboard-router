docker stop switchboard
docker rm switchboard
docker build -t switchboard .
docker run -d --name switchboard -p 20128:20128 --env-file .env -v switchboard-data:/app/data switchboard