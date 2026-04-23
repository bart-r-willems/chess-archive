<?php

/*
 *  pgn4web javascript chessboard
 *  copyright (C) 2009-2025 Paolo Casaschi
 *  see README file and http://pgn4web.casaschi.net
 *  for credits, license and more details
 */

error_reporting(E_ALL | E_STRICT);

function get_param($param, $shortParam, $default, $pattern) {
  $retVal = $default;
  if (isset($_REQUEST[$param])) { $retVal = $_REQUEST[$param]; }
  else if (isset($_REQUEST[$shortParam])) { $retVal = $_REQUEST[$shortParam]; }
  if (($pattern) && (!preg_match($pattern, $retVal))) { $retVal = $default; }
  return $retVal;
}

$pgnData = get_param("pgnData", "pd", "gotd.pgn", "");


function get_pgnText($pgnUrl) {
  if (strpos($pgnUrl, ":") || (strpos($pgnUrl, "%3A"))) { return "[Event \"error: invalid pgnData=$pgnUrl\"]\n"; }
  $fileLimitBytes = 10000000; // 10Mb
  $pgnText = file_get_contents($pgnUrl, FALSE, NULL, 0, $fileLimitBytes + 1);
  if (!$pgnText) { return "[Event \"error: failed to get pgnData=$pgnUrl\"]\n"; }
  $pgnText = str_replace(array("&", "<", ">"), array("&amp;", "&lt;", "&gt;"), $pgnText);
  return $pgnText;
}

$pgnText = get_pgnText($pgnData);

$numGames = preg_match_all("/(\s*\[\s*(\w+)\s*\"([^\"]*)\"\s*\]\s*)+[^\[]*/", $pgnText, $games );


$gameNum = get_param("gameNum", "gn", "", "/^[-+0-9a-z ]*$/i");

$expiresDate = "";
if ($gameNum == "random") { $gameNum = rand(1, $numGames); }
else if (!preg_match("/^\d+$/", $gameNum)) {
  $timeNow = time();
  $expiresDate = gmdate("D, d M Y H:i:s", (floor($timeNow / (60 * 60 * 24)) + 1) * (60 * 60 * 24)) . " GMT";
  if (!preg_match("/^[ +-]\d+$/", $gameNum)) { $gameNum = 0; } // space is needed since + is urldecoded as space
  $gameNum = floor(($gameNum + (int) ($timeNow / (60 * 60 * 24))) % $numGames) + 1;
}
else if ($gameNum < 1) { $gameNum = 1; }
else if ($gameNum > $numGames) { $gameNum = $numGames; }
$gameNum -= 1;

header("content-type: application/x-chess-pgn");
header("content-disposition: inline; filename=game.pgn");
if ($expiresDate) {
  header("expires: " . $expiresDate);
}
print $games[0][$gameNum];

?>
