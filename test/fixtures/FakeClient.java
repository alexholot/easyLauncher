import java.io.*;
import java.net.*;
import java.nio.file.*;

// Имитация клиента Minecraft: печатает аргументы, подключается к --quickPlayMultiplayer,
// по FAKE_SP_LEVEL пишет в журнал одиночную сессию со скриншотом — как настоящий клиент.
public class FakeClient {
  static void varint(ByteArrayOutputStream o, int v) {
    do {
      int b = v & 0x7f;
      v >>>= 7;
      if (v != 0) b |= 0x80;
      o.write(b);
    } while (v != 0);
  }
  static void str(ByteArrayOutputStream o, String s) throws IOException {
    byte[] b = s.getBytes("UTF-8");
    varint(o, b.length);
    o.write(b);
  }
  static byte[] packet(byte[] body) throws IOException {
    ByteArrayOutputStream o = new ByteArrayOutputStream();
    varint(o, body.length);
    o.write(body);
    return o.toByteArray();
  }
  /** Рукопожатие (протокол 767, состояние «вход») и «начало входа» с ником — как у Minecraft 1.21. */
  static byte[] loginPackets(String host, int port, String user) throws IOException {
    ByteArrayOutputStream hs = new ByteArrayOutputStream();
    varint(hs, 0);
    varint(hs, 767);
    str(hs, host);
    hs.write((port >> 8) & 0xff);
    hs.write(port & 0xff);
    varint(hs, 2);
    ByteArrayOutputStream ls = new ByteArrayOutputStream();
    varint(ls, 0);
    str(ls, user);
    ls.write(new byte[16]);
    ByteArrayOutputStream all = new ByteArrayOutputStream();
    all.write(packet(hs.toByteArray()));
    all.write(packet(ls.toByteArray()));
    return all.toByteArray();
  }

  public static void main(String[] a) throws Exception {
    String mp = null;
    String gameDir = ".";
    String user = "Player";
    for (int i = 0; i < a.length; i++) {
      System.out.println("arg:" + a[i]);
      if (a[i].equals("--quickPlayMultiplayer") && i + 1 < a.length) mp = a[i + 1];
      if (a[i].equals("--gameDir") && i + 1 < a.length) gameDir = a[i + 1];
      if (a[i].equals("--username") && i + 1 < a.length) user = a[i + 1];
    }
    if (mp != null) {
      String[] hp = mp.split(":");
      try (Socket s = new Socket(hp[0], Integer.parseInt(hp[1]))) {
        // как настоящий клиент: рукопожатие и «начало входа» с ником, затем данные игры
        byte[] login = loginPackets(hp[0], Integer.parseInt(hp[1]), user);
        OutputStream o = s.getOutputStream();
        o.write(login);
        o.write("hello\n".getBytes());
        o.flush();
        // сервер-заглушка возвращает всё обратно: пропускаем пакет входа, читаем «hello»
        InputStream in = s.getInputStream();
        byte[] all = new byte[login.length + 6];
        int got = 0;
        while (got < all.length) {
          int n = in.read(all, got, all.length - got);
          if (n < 0) break;
          got += n;
        }
        System.out.println("connected:" + (got > login.length ? new String(all, login.length, got - login.length).trim() : "refused"));
      } catch (IOException e) {
        System.out.println("connected:refused");
      }
    }
    // пробный запуск: «загрузилась», «вылетела», «экран ошибок Forge», вылет из-за мода или пары модов в папке mods
    String probe = System.getenv("FAKE_PROBE");
    if (probe != null) {
      java.util.List<String> mods = new java.util.ArrayList<>();
      File[] fs = new File(gameDir, "mods").listFiles();
      if (fs != null) for (File f : fs) if (f.getName().endsWith(".jar")) mods.add(f.getName().toLowerCase());
      System.out.println("mods:" + String.join(",", mods));
      boolean crash = probe.equals("crash");
      String one = System.getenv("FAKE_CRASH_IF_MOD");
      if (one != null) for (String m : mods) if (m.contains(one.toLowerCase())) crash = true;
      String both = System.getenv("FAKE_CRASH_IF_BOTH");
      if (both != null) {
        String[] ab = both.toLowerCase().split(",");
        boolean hasA = false, hasB = false;
        for (String m : mods) { if (m.contains(ab[0])) hasA = true; if (m.contains(ab[1])) hasB = true; }
        if (hasA && hasB) crash = true;
      }
      Thread.sleep(150);
      if (crash) {
        System.out.println("---- Minecraft Crash Report ----");
        System.out.println("java.lang.NullPointerException: test crash");
        System.exit(-1);
      }
      if (probe.equals("forge-errors")) System.out.println("[main/ERROR] [ne.mi.fm.ModLoader/]: Skipping lifecycle event ENQUEUE_IMC, 1 errors found.");
      if (!probe.equals("hang")) System.out.println("[Render thread/INFO]: Sound engine started");
      Thread.sleep(120000);
      return;
    }
    String ms = System.getenv("FAKE_CLIENT_MS");
    String level = System.getenv("FAKE_SP_LEVEL");
    if (level != null) {
      System.out.println("[Server thread/INFO]: Starting integrated minecraft server version 1.21.1");
      Thread.sleep(ms == null ? 300 : Long.parseLong(ms));
      Path shots = Paths.get(gameDir, "screenshots");
      Files.createDirectories(shots);
      String name = "2026-10-26_12.00.0" + (System.nanoTime() % 10) + ".png";
      // настоящий PNG с явной пометкой: это тестовый снимок, а не кадр из Minecraft
      java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(640, 360, java.awt.image.BufferedImage.TYPE_INT_RGB);
      java.awt.Graphics2D g = img.createGraphics();
      g.setPaint(new java.awt.GradientPaint(0, 0, new java.awt.Color(70, 110, 160), 640, 360, new java.awt.Color(60, 120, 60)));
      g.fillRect(0, 0, 640, 360);
      g.setColor(java.awt.Color.WHITE);
      g.setFont(new java.awt.Font(java.awt.Font.SANS_SERIF, java.awt.Font.BOLD, 28));
      g.drawString("TEST SCREENSHOT (not Minecraft)", 40, 190);
      g.dispose();
      javax.imageio.ImageIO.write(img, "png", shots.resolve(name).toFile());
      System.out.println("[Render thread/INFO]: [System] [CHAT] Saved screenshot as " + name);
      System.out.println("[Server thread/INFO]: Saving chunks for level 'ServerLevel[" + level + "]'/minecraft:overworld");
      System.out.println("[Server thread/INFO]: Stopping server");
    } else Thread.sleep(ms == null ? 300 : Long.parseLong(ms));
    String code = System.getenv("FAKE_CLIENT_EXIT");
    if (code != null && !code.equals("0")) { System.err.println("java.lang.OutOfMemoryError: Java heap space"); System.exit(Integer.parseInt(code)); }
  }
}
