import http from 'http'

export default class MissionManager {

    static reportMissionProgress(counter, playerId) {
        var missionRequestData = {
            counter: counter,
            user_id: playerId
        };

        var serialised = JSON.stringify(missionRequestData);

        console.log(`mission progress report: ${serialised}`);

        var options = {
            hostname: 'missions',
            port: 8081,
            path: '/api/missionsv1/progress',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': serialised.length,
                'X-API-KEY': process.env.SPHERE_API_KEY
            },
        }

        var req = http.request(options, (res) => { console.log(`mission progress statusCode: ${res.statusCode}`); });
        req.on('error', (error) => { `mission progress error: ${console.error(error)}`; });
        req.write(serialised);
        req.end();
    }
}