import { createOpencodeClient } from "@opencode-ai/sdk";
const auth = "Basic " + Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME || "opencode"}:${process.env.OPENCODE_SERVER_PASSWORD || ""}`).toString("base64");
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetch: (u,i={}) => globalThis.fetch(u, {...i, headers: {...i.headers, Authorization: auth}}) });

const t0 = Date.now();
const s = await client.session.create({ body: { title: "[bench] ttft" } });
const sid = s.data.id;
console.log("ack_ms:", Date.now()-t0);

let ttft = null, last = "";
const events = await client.event.subscribe();
(async () => {
  for await (const ev of events.stream) {
    if (ev.type === "message.part.updated" && ev.properties?.sessionID === sid && ev.properties.part?.type === "text") {
      if (ttft === null && ev.properties.part.text.trim()) { ttft = Date.now()-t0; console.log("ttft_ms:", ttft); }
      last = ev.properties.part.text;
    }
  }
})();

await client.session.prompt({ path: { id: sid }, body: { model: {providerID:"omniroute", modelID:"auto/fast"}, parts: [{type:"text", text:"Responda em uma palavra: ola"}] } });
await new Promise(r => setTimeout(r, 1500));
console.log("total_ms:", Date.now()-t0);
console.log("final_len:", last.length);
process.exit(0);

