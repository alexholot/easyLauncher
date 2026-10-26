import java.io.*;
import java.net.*;
import java.nio.file.*;

// Имитация клиента Minecraft: печатает аргументы, подключается к --quickPlayMultiplayer,
// по FAKE_SP_LEVEL пишет в журнал одиночную сессию со скриншотом — как настоящий клиент.
public class FakeClient {
  public static void main(String[] a) throws Exception {
    String mp = null;
    String gameDir = ".";
    for (int i = 0; i < a.length; i++) {
      System.out.println("arg:" + a[i]);
      if (a[i].equals("--quickPlayMultiplayer") && i + 1 < a.length) mp = a[i + 1];
      if (a[i].equals("--gameDir") && i + 1 < a.length) gameDir = a[i + 1];
    }
    if (mp != null) {
      String[] hp = mp.split(":");
      try (Socket s = new Socket(hp[0], Integer.parseInt(hp[1]))) {
        s.getOutputStream().write("hello\n".getBytes());
        byte[] b = new byte[6];
        int n = s.getInputStream().read(b);
        System.out.println("connected:" + new String(b, 0, n).trim());
      }
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
