import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Bar icon plus popup, one per monitor. Holds no state of its own: all data
// comes from the plugin's single Service instance.
Panel {
  id: root
  moduleName: "ms007.omarchy-sandcastle-shell"
  ipcTarget: "ms007.omarchy-sandcastle-shell"

  readonly property var service: {
    var host = root.bar && root.bar.shell ? root.bar.shell : null
    if (!host || typeof host.serviceFor !== "function") return null
    try { return host.serviceFor(root.moduleName) } catch (e) { return null }
  }
  readonly property var snapshot: service ? service.snapshot : null
  readonly property bool runActive: service ? service.active === true : false
  readonly property string level: service ? service.level : "normal"

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color iconColor: level === "urgent" ? urgent
    : level === "warn" ? Commons.Color.accent : barForeground

  // Popup clock: ticks only while the popup is open.
  property double now: Date.now()
  readonly property var rows: Model.ticketRows(snapshot)
  readonly property double lastOutputAt: service ? service.lastOutputAt : 0

  // -1 is the header (spec), 0.. the ticket rows.
  property int cursorIndex: -1
  property bool cursorActive: false

  visible: runActive
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onRunActiveChanged: if (!runActive) close()
  onOpenedChanged: if (opened) {
    now = Date.now()
    cursorActive = false
    cursorIndex = -1
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function openUrl(url) {
    if (!url) return
    Util.execArgv(["xdg-open", url])
    close()
  }

  function activate(index) {
    if (index < 0) openUrl(snapshot && snapshot.spec ? snapshot.spec.url : "")
    else if (index < rows.length) openUrl(rows[index].url)
  }

  function moveCursor(dy) {
    if (!cursorActive) { cursorActive = true; return }
    var last = snapshot && snapshot.standalone ? -1 : rows.length - 1
    cursorIndex = Math.max(-1, Math.min(last, cursorIndex + dy))
  }

  Timer {
    interval: 1000
    repeat: true
    running: root.opened
    onTriggered: root.now = Date.now()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.GLYPHS.plant
    foreground: root.iconColor
    tooltipText: root.snapshot
      ? "Sandcastle · Spec #" + root.snapshot.spec.number + (Model.progressText(root.snapshot) ? " · " + Model.progressText(root.snapshot) : "")
      : "Sandcastle"
    onPressed: function(buttonCode) { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened && root.runActive
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }
      onActivateRequested: if (root.cursorActive) root.activate(root.cursorIndex)
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: flick.width
          spacing: Style.space(12)

          // Header: the spec issue.
          CursorSurface {
            width: parent.width
            implicitHeight: hero.implicitHeight + Style.space(8)
            hasCursor: root.cursorActive && root.cursorIndex === -1
            foreground: root.foreground

            MouseArea {
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onEntered: { root.cursorActive = true; root.cursorIndex = -1 }
              onClicked: root.activate(-1)
            }

            PanelHero {
              id: hero
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              title: root.snapshot ? "Spec #" + root.snapshot.spec.number : "Sandcastle"
              meta: root.snapshot ? String(root.snapshot.spec.title || "") : ""
              detail: {
                var parts = []
                var progress = Model.progressText(root.snapshot)
                if (progress) parts.push(progress)
                var duration = Model.runDuration(root.snapshot, root.now)
                if (duration) parts.push("läuft seit " + duration)
                return parts.join(" · ")
              }
              foreground: root.foreground
              fontFamily: root.fontFamily
              iconComponent: Component {
                Text {
                  text: Model.GLYPHS.plant
                  color: root.iconColor
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }
            }
          }

          Text {
            visible: root.service !== null && root.service.formatError !== ""
            width: parent.width
            text: root.service ? root.service.formatError : ""
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          // A lone issue: just the diagnostics line, no ticket list.
          Text {
            visible: root.snapshot !== null && root.snapshot.standalone === true
            width: parent.width
            leftPadding: Style.space(6)
            text: Model.diagLine(root.snapshot, root.lastOutputAt, root.now)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          PanelSeparator {
            visible: root.snapshot !== null && root.snapshot.standalone !== true
            foreground: root.foreground
          }

          Column {
            visible: root.snapshot !== null && root.snapshot.standalone !== true
            width: parent.width
            spacing: Style.space(10)

            PanelSectionHeader {
              text: "TICKETS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Column {
              id: rowColumn
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: root.rows
                TicketRow {
                  required property var modelData
                  required property int index
                  width: rowColumn.width
                  row: modelData
                  rowIndex: index
                }
              }
            }
          }
        }
      }
    }
  }

  component TicketRow: CursorSurface {
    id: ticketRow
    property var row: null
    property int rowIndex: 0
    readonly property bool muted: row && (row.kind === "alreadyDone" || row.kind === "skipped" || row.kind === "notStarted")
    readonly property color rowColor: row && row.kind === "failed" ? root.urgent : root.foreground

    hasCursor: root.cursorActive && root.cursorIndex === rowIndex
    foreground: root.foreground
    implicitHeight: content.implicitHeight + Style.spacing.rowPaddingX

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: { root.cursorActive = true; root.cursorIndex = ticketRow.rowIndex }
      onClicked: root.activate(ticketRow.rowIndex)
    }

    RowLayout {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.space(10)
      anchors.rightMargin: Style.space(10)
      spacing: Style.space(10)

      Text {
        textFormat: Text.PlainText
        text: ticketRow.row ? ticketRow.row.glyph : ""
        color: ticketRow.rowColor
        opacity: ticketRow.muted ? 0.5 : 1
        font.family: root.fontFamily
        font.pixelSize: Style.font.icon
        Layout.preferredWidth: Style.space(18)
        horizontalAlignment: Text.AlignHCenter
        Layout.alignment: Qt.AlignVCenter
      }

      ColumnLayout {
        id: content
        Layout.fillWidth: true
        spacing: Style.space(1)

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: ticketRow.row ? "#" + ticketRow.row.number + "  " + ticketRow.row.title : ""
          color: ticketRow.rowColor
          opacity: ticketRow.muted ? 0.6 : 1
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.bold: ticketRow.row ? ticketRow.row.active : false
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: ticketRow.row && ticketRow.row.active
            ? Model.diagLine(root.snapshot, root.lastOutputAt, root.now)
            : (ticketRow.row ? ticketRow.row.label : "")
          color: ticketRow.row && ticketRow.row.active && root.level === "warn" ? Commons.Color.accent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          maximumLineCount: 2
        }
      }
    }
  }
}
