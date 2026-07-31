import { Client } from "ssh2";
const c = new Client();
c.on("ready", () => {
  c.exec("systemctl stop cmms-api.service", (err, s) => {
    s.on("close", () => { c.end(); console.log("stopped"); });
  });
});
c.on("error", (e: Error) => console.log("err:", e.message));
c.connect({ host: "10.0.3.81", port: 22, username: "root", password: "tarantula999" });
