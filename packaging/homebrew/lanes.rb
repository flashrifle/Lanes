# Homebrew cask for Lanes. Lives in the tap repo github.com/flashrifle/homebrew-tap as Casks/lanes.rb.
# On each release: bump `version`, set `sha256` to `shasum -a 256 Lanes_<version>_universal.dmg`.
cask "lanes" do
  version "0.1.0"
  sha256 "7e0e08663861ab65eb3e15a8c29580b66150ea1ab65076642258ee2c1077ad08"

  url "https://github.com/flashrifle/Lanes/releases/download/v#{version}/Lanes_#{version}_universal.dmg"
  name "Lanes"
  desc "Standalone Git log viewer modelled on the JetBrains Git tool window"
  homepage "https://github.com/flashrifle/Lanes"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on macos: ">= :big_sur"

  app "Lanes.app"

  zap trash: [
    "~/Library/Application Support/io.github.flashrifle.lanes",
    "~/Library/Caches/io.github.flashrifle.lanes",
    "~/Library/Preferences/io.github.flashrifle.lanes.plist",
    "~/Library/Saved Application State/io.github.flashrifle.lanes.savedState",
    "~/Library/WebKit/io.github.flashrifle.lanes",
  ]
end
