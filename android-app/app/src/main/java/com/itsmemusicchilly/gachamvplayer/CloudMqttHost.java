package com.itsmemusicchilly.gachamvplayer;

import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Hosts the cloud room from the app process, on the same secure WebSocket
 * brokers the phone remote uses (EMQX 8084, then HiveMQ 8884). Port 1883 is
 * often dropped by TV and mobile networks, which left the phone on
 * "connecting" with no player on the other end.
 */
public class CloudMqttHost {

    private static final String TAG = "GCMV_CloudMqtt";
    // Mobile carrier NAT tables often expire an idle TCP mapping well under 20s,
    // silently dropping the connection before our old 20s idle-ping ever fired.
    private static final int IDLE_PING_MS = 8000;
    private static final Broker[] BROKERS = new Broker[] {
            new Broker("EMQX", "broker.emqx.io", 8084, "/mqtt"),
            new Broker("HiveMQ", "broker.hivemq.com", 8884, "/mqtt")
    };

    public interface CommandListener {
        void onCommand(JSONObject command);
    }

    private static final class Broker {
        final String name;
        final String host;
        final int port;
        final String path;

        Broker(String name, String host, int port, String path) {
            this.name = name;
            this.host = host;
            this.port = port;
            this.path = path;
        }
    }

    private static final class Link {
        final Broker broker;
        final Socket socket;
        final InputStream in;
        final OutputStream out;
        final AtomicBoolean alive = new AtomicBoolean(true);
        byte[] mqtt = new byte[8192];
        int mqttLen = 0;

        Link(Broker broker, Socket socket, InputStream in, OutputStream out) {
            this.broker = broker;
            this.socket = socket;
            this.in = in;
            this.out = out;
        }
    }

    private final CommandListener listener;
    private final CopyOnWriteArrayList<Link> links = new CopyOnWriteArrayList<>();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final SecureRandom random = new SecureRandom();
    private final ExecutorService dnsExecutor = Executors.newCachedThreadPool();
    private volatile int session = 0;
    private volatile String roomCode = "";
    private volatile String cmdTopic = "";
    private volatile String stateTopic = "";
    private volatile String retainedState = null;
    private int packetId = 1;

    public CloudMqttHost(CommandListener listener) {
        this.listener = listener;
    }

    public static String sanitizeRoomCode(String raw) {
        if (raw == null) return "";
        return raw.toUpperCase(Locale.US).replaceAll("[^A-Z0-9]", "");
    }

    public void start(String displayRoomCode) {
        String clean = sanitizeRoomCode(displayRoomCode);
        if (clean.isEmpty()) return;
        if (running.get() && clean.equals(roomCode)) return;
        final int gen = ++session;
        for (Link link : links) {
            closeLink(link);
        }
        links.clear();
        roomCode = clean;
        cmdTopic = "gcmv/room/" + clean + "/cmd";
        stateTopic = "gcmv/room/" + clean + "/state";
        running.set(true);
        for (Broker broker : BROKERS) {
            Thread thread = new Thread(() -> runBroker(broker, gen), "gcmv-mqtt-" + broker.name);
            thread.setDaemon(true);
            thread.start();
        }
    }

    public void stop() {
        session++;
        running.set(false);
        roomCode = "";
        for (Link link : links) {
            closeLink(link);
        }
        links.clear();
        dnsExecutor.shutdownNow();
    }

    public boolean isRunning() {
        return running.get();
    }

    public void publish(String json, boolean retain) {
        if (json == null || json.isEmpty() || stateTopic.isEmpty()) return;
        if (retain) retainedState = json;
        byte[] packet = encodePublish(stateTopic, json.getBytes(StandardCharsets.UTF_8), retain);
        for (Link link : links) {
            writeLink(link, packet);
        }
    }

    private void runBroker(Broker broker, int gen) {
        long backoffMs = 2000;
        while (running.get() && gen == session) {
            Link link = null;
            try {
                link = openLink(broker);
                links.add(link);
                String clientId = "gcmv-apk-" + broker.name.toLowerCase(Locale.US) + "-" + Long.toString(System.nanoTime() & 0xFFFFFFFL, 36);
                writeLink(link, encodeConnect(clientId));
                byte[] connack = nextMqttPacket(link);
                if (connack == null || connack.length < 4 || (connack[0] & 0xF0) != 0x20 || connack[connack.length - 1] != 0) {
                    throw new Exception(broker.name + " rejected CONNECT");
                }
                writeLink(link, encodeSubscribe(cmdTopic));
                Log.i(TAG, "Cloud room " + roomCode + " online via " + broker.name + ", subscribed to " + cmdTopic);
                backoffMs = 2000;
                String retained = retainedState;
                if (retained != null) {
                    writeLink(link, encodePublish(stateTopic, retained.getBytes(StandardCharsets.UTF_8), true));
                }
                link.socket.setSoTimeout(IDLE_PING_MS);
                readLoop(link);
            } catch (Exception e) {
                Log.w(TAG, broker.name + " cloud link dropped: " + e.getMessage());
            } finally {
                if (link != null) {
                    links.remove(link);
                    closeLink(link);
                }
            }
            if (running.get() && gen == session) {
                sleepQuiet(backoffMs);
                backoffMs = Math.min(backoffMs * 2, 60000);
            }
        }
    }

    private Link openLink(Broker broker) throws Exception {
        InetAddress address = resolve(broker.host, 3000);
        Socket tcp = new Socket();
        tcp.connect(new InetSocketAddress(address, broker.port), 4000);
        tcp.setTcpNoDelay(true);
        tcp.setKeepAlive(true);
        SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket ssl = (SSLSocket) factory.createSocket(tcp, broker.host, broker.port, true);
        ssl.setSoTimeout(5000);
        ssl.startHandshake();
        if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(broker.host, ssl.getSession())) {
            ssl.close();
            throw new Exception("certificate mismatch for " + broker.host);
        }
        OutputStream out = ssl.getOutputStream();
        InputStream in = ssl.getInputStream();
        byte[] key = new byte[16];
        random.nextBytes(key);
        String request = "GET " + broker.path + " HTTP/1.1\r\n"
                + "Host: " + broker.host + ":" + broker.port + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + Base64.encodeToString(key, Base64.NO_WRAP) + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "Sec-WebSocket-Protocol: mqtt\r\n"
                + "\r\n";
        out.write(request.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String status = readHttpHeaders(in);
        if (status == null || !status.contains("101")) {
            ssl.close();
            throw new Exception("websocket upgrade failed: " + status);
        }
        return new Link(broker, ssl, in, out);
    }

    private InetAddress resolve(String host, int timeoutMs) throws Exception {
        return dnsExecutor.submit(() -> InetAddress.getByName(host)).get(timeoutMs, TimeUnit.MILLISECONDS);
    }

    private String readHttpHeaders(InputStream in) throws Exception {
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        while (raw.size() < 4096) {
            int b = in.read();
            if (b < 0) break;
            raw.write(b);
            byte[] data = raw.toByteArray();
            int n = data.length;
            if (n >= 4 && data[n - 4] == '\r' && data[n - 3] == '\n' && data[n - 2] == '\r' && data[n - 1] == '\n') {
                String text = raw.toString(StandardCharsets.US_ASCII.name());
                int lineEnd = text.indexOf("\r\n");
                return lineEnd > 0 ? text.substring(0, lineEnd) : text;
            }
        }
        return null;
    }

    private void readLoop(Link link) throws Exception {
        while (running.get() && link.alive.get()) {
            byte[] packet;
            try {
                packet = nextMqttPacket(link);
            } catch (java.net.SocketTimeoutException timeout) {
                writeLink(link, new byte[] {(byte) 0xC0, 0x00});
                continue;
            }
            if (packet == null) return;
            int[] parsed = splitPacket(packet, 0, packet.length);
            if (parsed == null) continue;
            handlePacket(packet, 0, parsed[1], parsed[2]);
        }
    }

    private byte[] nextMqttPacket(Link link) throws Exception {
        while (running.get() && link.alive.get()) {
            int[] parsed = splitPacket(link.mqtt, 0, link.mqttLen);
            if (parsed != null) {
                int total = parsed[0];
                byte[] packet = new byte[total];
                System.arraycopy(link.mqtt, 0, packet, 0, total);
                int keep = link.mqttLen - total;
                if (keep > 0) System.arraycopy(link.mqtt, total, link.mqtt, 0, keep);
                link.mqttLen = keep;
                return packet;
            }
            byte[] frame = readWsData(link);
            if (frame == null) return null;
            if (link.mqtt.length - link.mqttLen < frame.length) {
                byte[] bigger = new byte[Math.max(link.mqtt.length * 2, link.mqttLen + frame.length)];
                System.arraycopy(link.mqtt, 0, bigger, 0, link.mqttLen);
                link.mqtt = bigger;
            }
            System.arraycopy(frame, 0, link.mqtt, link.mqttLen, frame.length);
            link.mqttLen += frame.length;
        }
        return null;
    }

    private byte[] readWsData(Link link) throws Exception {
        while (true) {
            int b0;
            try {
                b0 = link.in.read();
            } catch (java.net.SocketTimeoutException idle) {
                throw idle;
            }
            if (b0 < 0) return null;
            link.socket.setSoTimeout(5000);
            int b1;
            try {
                b1 = link.in.read();
            } catch (java.net.SocketTimeoutException stalled) {
                throw new Exception("websocket frame stalled");
            } finally {
                try { link.socket.setSoTimeout(IDLE_PING_MS); } catch (Exception ignored) {}
            }
            if (b1 < 0) return null;
            int opcode = b0 & 0x0F;
            boolean masked = (b1 & 0x80) != 0;
            int length = b1 & 0x7F;
            if (length == 126) {
                byte[] ext = new byte[2];
                readFully(link.in, ext, 0, 2);
                length = ((ext[0] & 0xFF) << 8) | (ext[1] & 0xFF);
            } else if (length == 127) {
                byte[] ext = new byte[8];
                readFully(link.in, ext, 0, 8);
                length = ((ext[4] & 0xFF) << 24) | ((ext[5] & 0xFF) << 16) | ((ext[6] & 0xFF) << 8) | (ext[7] & 0xFF);
            }
            if (length < 0 || length > 1024 * 1024) throw new Exception("websocket frame too large");
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(link.in, mask, 0, 4);
            }
            byte[] payload = new byte[length];
            if (length > 0) readFully(link.in, payload, 0, length);
            if (mask != null) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] = (byte) (payload[i] ^ mask[i & 3]);
                }
            }
            if (opcode == 0x8) return null;
            if (opcode == 0x9) {
                writeWsFrame(link, 0x8A, payload);
                continue;
            }
            if (opcode == 0xA) continue;
            if (opcode == 0x1 || opcode == 0x2 || opcode == 0x0) return payload;
        }
    }

    private void readFully(InputStream in, byte[] buf, int off, int len) throws Exception {
        int got = 0;
        while (got < len) {
            int n = in.read(buf, off + got, len - got);
            if (n < 0) throw new Exception("socket closed");
            got += n;
        }
    }

    /** @return [totalLength, variableHeaderOffset, remainingLength] or null if incomplete */
    private int[] splitPacket(byte[] buf, int off, int len) throws Exception {
        if (len - off < 2) return null;
        int multiplier = 1;
        int remaining = 0;
        int pos = off + 1;
        int used = 0;
        int digit;
        while (true) {
            if (pos >= len) return null;
            digit = buf[pos++] & 0xFF;
            remaining += (digit & 127) * multiplier;
            multiplier *= 128;
            used++;
            if (used > 4) throw new Exception("bad MQTT remaining length");
            if ((digit & 128) == 0) break;
        }
        int total = 1 + used + remaining;
        if (len - off < total) return null;
        if (total > 1024 * 1024) throw new Exception("MQTT packet too large");
        return new int[] { total, pos - off, remaining };
    }

    private void handlePacket(byte[] buf, int off, int header, int remaining) {
        int type = buf[off] & 0xF0;
        Log.d(TAG, "packet type=0x" + Integer.toHexString(type) + " remaining=" + remaining);
        if (type != 0x30) return;
        int pos = off + header;
        int end = pos + remaining;
        if (pos + 2 > end) return;
        int topicLen = ((buf[pos] & 0xFF) << 8) | (buf[pos + 1] & 0xFF);
        pos += 2;
        if (topicLen < 0 || pos + topicLen > end) return;
        String topic = new String(buf, pos, topicLen, StandardCharsets.UTF_8);
        pos += topicLen;
        int qos = (buf[off] >> 1) & 0x03;
        if (qos > 0) pos += 2;
        if (pos > end) return;
        Log.d(TAG, "PUBLISH on topic=" + topic + " expecting cmdTopic=" + cmdTopic);
        if (!topic.equals(cmdTopic)) return;
        String body = new String(buf, pos, end - pos, StandardCharsets.UTF_8);
        try {
            JSONObject cmd = new JSONObject(body);
            if (listener != null) listener.onCommand(cmd);
        } catch (Exception e) {
            Log.w(TAG, "Bad cloud command: " + e.getMessage());
        }
    }

    private void writeLink(Link link, byte[] packet) {
        if (link == null || packet == null || packet.length == 0 || !link.alive.get()) return;
        try {
            writeWsFrame(link, 0x82, packet);
        } catch (Exception e) {
            link.alive.set(false);
            closeLink(link);
        }
    }

    private void writeWsFrame(Link link, int opcode, byte[] payload) throws Exception {
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        int length = payload == null ? 0 : payload.length;
        ByteArrayOutputStream frame = new ByteArrayOutputStream(length + 14);
        frame.write(opcode);
        if (length < 126) {
            frame.write(0x80 | length);
        } else if (length <= 65535) {
            frame.write(0x80 | 126);
            frame.write((length >> 8) & 0xFF);
            frame.write(length & 0xFF);
        } else {
            frame.write(0x80 | 127);
            for (int shift = 56; shift >= 0; shift -= 8) {
                frame.write((int) ((((long) length) >> shift) & 0xFF));
            }
        }
        frame.write(mask);
        if (payload != null) {
            for (int i = 0; i < payload.length; i++) {
                frame.write(payload[i] ^ mask[i & 3]);
            }
        }
        synchronized (link.out) {
            link.out.write(frame.toByteArray());
            link.out.flush();
        }
    }

    private void closeLink(Link link) {
        link.alive.set(false);
        try { link.socket.close(); } catch (Exception ignored) {}
    }

    private byte[] encodeConnect(String clientId) throws Exception {
        ByteArrayOutputStream variable = new ByteArrayOutputStream();
        writeMqttString(variable, "MQTT");
        variable.write(4);
        variable.write(0x02);
        variable.write(0);
        variable.write(30);
        writeMqttString(variable, clientId);
        return withFixedHeader(0x10, variable.toByteArray());
    }

    private synchronized byte[] encodeSubscribe(String topic) throws Exception {
        ByteArrayOutputStream variable = new ByteArrayOutputStream();
        int id = packetId++;
        if (packetId > 65535) packetId = 1;
        variable.write((id >> 8) & 0xFF);
        variable.write(id & 0xFF);
        writeMqttString(variable, topic);
        variable.write(0);
        return withFixedHeader(0x82, variable.toByteArray());
    }

    private byte[] encodePublish(String topic, byte[] payload, boolean retain) {
        try {
            ByteArrayOutputStream variable = new ByteArrayOutputStream();
            writeMqttString(variable, topic);
            variable.write(payload);
            int flags = retain ? 0x31 : 0x30;
            return withFixedHeader(flags, variable.toByteArray());
        } catch (Exception e) {
            return new byte[0];
        }
    }

    private byte[] withFixedHeader(int first, byte[] variable) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(first);
        int length = variable.length;
        do {
            int digit = length % 128;
            length /= 128;
            if (length > 0) digit |= 0x80;
            out.write(digit);
        } while (length > 0);
        out.write(variable);
        return out.toByteArray();
    }

    private void writeMqttString(ByteArrayOutputStream out, String value) throws Exception {
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        out.write((data.length >> 8) & 0xFF);
        out.write(data.length & 0xFF);
        out.write(data);
    }

    private void sleepQuiet(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
}
