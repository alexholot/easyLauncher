import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.util.*;

// Имитация выделенного сервера Minecraft для тестов оркестратора (не Minecraft).
public class FakeServer {
  static volatile boolean running = true;

  // level.dat в формате NBT (gzip): Data{LevelName, LastPlayed, GameType, hardcore} — как у настоящего мира
  static void writeLevel(Path file, String name, int gameType) throws IOException {
    try (DataOutputStream o = new DataOutputStream(new java.util.zip.GZIPOutputStream(Files.newOutputStream(file)))) {
      o.writeByte(10); o.writeUTF("");
      o.writeByte(10); o.writeUTF("Data");
      o.writeByte(8); o.writeUTF("LevelName"); o.writeUTF(name);
      o.writeByte(4); o.writeUTF("LastPlayed"); o.writeLong(System.currentTimeMillis());
      o.writeByte(3); o.writeUTF("GameType"); o.writeInt(gameType);
      o.writeByte(1); o.writeUTF("hardcore"); o.writeByte(0);
      o.writeByte(0);
      o.writeByte(0);
    }
  }
  public static void main(String[] a) throws Exception {
    String universe = ".", world = "world";
    for (int i = 0; i < a.length - 1; i++) {
      if (a[i].equals("--universe")) universe = a[i + 1];
      if (a[i].equals("--world")) world = a[i + 1];
    }
    String eula = Files.exists(Paths.get("eula.txt")) ? new String(Files.readAllBytes(Paths.get("eula.txt"))) : "";
    if (!eula.contains("eula=true")) { System.out.println("[main/WARN]: Failed to load eula.txt"); System.out.println("[main/INFO]: You need to agree to the EULA in order to run the server."); System.exit(0); }
    Properties p = new Properties();
    try (Reader r = new FileReader("server.properties")) { p.load(r); }
    if ("port".equals(System.getenv("FAKE_FAIL"))) { System.out.println("[Server thread/WARN]: **** FAILED TO BIND TO PORT!"); System.exit(1); }
    int port = Integer.parseInt(p.getProperty("server-port", "25565"));
    ServerSocket ss = new ServerSocket(port, 50, InetAddress.getByName("0.0.0.0"));
    Path dir = Paths.get(universe, world);
    Files.createDirectories(dir);
    Path level = dir.resolve("level.dat");
    if (!Files.exists(level)) {
      Files.write(dir.resolve("fake-props.txt"), ("seed=" + p.getProperty("level-seed", "") + ";gamemode=" + p.getProperty("gamemode") + ";online=" + p.getProperty("online-mode") + ";whitelist=" + p.getProperty("white-list")).getBytes());
      writeLevel(level, world, "creative".equals(p.getProperty("gamemode")) ? 1 : 0);
    }
    Files.write(dir.resolve("session.lock"), new byte[]{1});
    System.out.println("[Server thread/INFO]: Preparing level \"" + world + "\"");
    Thread acceptor = new Thread(() -> {
      while (running) {
        try {
          Socket s = ss.accept();
          new Thread(() -> { try { InputStream in = s.getInputStream(); OutputStream out = s.getOutputStream(); byte[] b = new byte[65536]; int n; while ((n = in.read(b)) > 0) { out.write(b, 0, n); out.flush(); } s.close(); } catch (IOException e) {} }).start();
        } catch (IOException e) { }
      }
    });
    acceptor.setDaemon(true); acceptor.start();
    System.out.println("[Server thread/INFO]: Done (0.42s)! For help, type \"help\"");
    BufferedReader r = new BufferedReader(new InputStreamReader(System.in));
    String l;
    while ((l = r.readLine()) != null) {
      if (l.equals("stop")) { System.out.println("[Server thread/INFO]: Stopping server"); System.out.println("[Server thread/INFO]: Saving worlds"); Files.deleteIfExists(dir.resolve("session.lock")); running = false; ss.close(); System.exit(0); }
      else if (l.startsWith("save-all")) { Files.write(dir.resolve("saved.txt"), ("saved " + System.nanoTime()).getBytes()); System.out.println("[Server thread/INFO]: Saved the game"); }
      else if (l.equals("save-off")) System.out.println("[Server thread/INFO]: Automatic saving is now disabled");
      else if (l.equals("save-on")) System.out.println("[Server thread/INFO]: Automatic saving is now enabled");
      else if (l.startsWith("whitelist add ")) System.out.println("[Server thread/INFO]: Added " + l.substring(14) + " to the whitelist");
      else if (l.startsWith("join ")) System.out.println("[Server thread/INFO]: " + l.substring(5) + " joined the game");
      else if (l.equals("crash")) { System.out.println("[Server thread/ERROR]: Encountered an unexpected exception"); System.exit(1); }
      else System.out.println("[Server thread/INFO]: Unknown command " + l);
    }
  }
}
