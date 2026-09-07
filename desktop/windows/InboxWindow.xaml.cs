using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.IO;
using Forms = System.Windows.Forms;
using WpfDataFormats = System.Windows.DataFormats;
using WpfDataObject = System.Windows.DataObject;
using WpfDragDropEffects = System.Windows.DragDropEffects;
using WpfMessageBox = System.Windows.MessageBox;
using WpfMouseEventArgs = System.Windows.Input.MouseEventArgs;
using WpfPoint = System.Windows.Point;

namespace XingqiaoDesktop;

public partial class InboxWindow : Window
{
    private readonly TempInboxStore _store;
    private WpfPoint _dragStart;
    private bool _allowClose;

    public InboxWindow(TempInboxStore store)
    {
        _store = store;
        InitializeComponent();
        DataContext = store;
        _store.Changed += Refresh;
        Refresh();
    }

    public void ShowInbox()
    {
        Refresh();
        if (!IsVisible) Show();
        Activate();
        Topmost = true;
    }

    public void CloseForApplication()
    {
        _allowClose = true;
        Close();
    }

    private void Refresh()
    {
        if (!Dispatcher.CheckAccess()) { Dispatcher.Invoke(Refresh); return; }
        EmptyText.Visibility = _store.Files.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        var hasSelection = FilesList.SelectedItem is TransferFile;
        SaveButton.IsEnabled = hasSelection;
        RemoveButton.IsEnabled = hasSelection;
    }

    private void FilesList_SelectionChanged(object sender, SelectionChangedEventArgs e) => Refresh();

    private void FilesList_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _dragStart = e.GetPosition(null);
        var item = ItemsControl.ContainerFromElement(FilesList, e.OriginalSource as DependencyObject) as ListBoxItem;
        if (item?.DataContext is TransferFile file) FilesList.SelectedItem = file;
    }

    private void FilesList_PreviewMouseMove(object sender, WpfMouseEventArgs e)
    {
        if (e.LeftButton != MouseButtonState.Pressed || FilesList.SelectedItem is not TransferFile file) return;
        var current = e.GetPosition(null);
        if (Math.Abs(current.X - _dragStart.X) < SystemParameters.MinimumHorizontalDragDistance &&
            Math.Abs(current.Y - _dragStart.Y) < SystemParameters.MinimumVerticalDragDistance) return;
        if (!File.Exists(file.Path)) return;
        var data = new WpfDataObject(WpfDataFormats.FileDrop, new[] { file.Path });
        DragDrop.DoDragDrop(FilesList, data, WpfDragDropEffects.Copy);
    }

    private void Save_Click(object sender, RoutedEventArgs e)
    {
        if (FilesList.SelectedItem is not TransferFile file) return;
        using var picker = new Forms.FolderBrowserDialog { Description = "选择星桥文件的保存位置", UseDescriptionForTitle = true };
        if (picker.ShowDialog() != Forms.DialogResult.OK) return;
        try { _store.Save(file, picker.SelectedPath); }
        catch (Exception error) { WpfMessageBox.Show($"无法保存文件：{error.Message}", "星桥", MessageBoxButton.OK, MessageBoxImage.Error); }
    }

    private void Remove_Click(object sender, RoutedEventArgs e)
    {
        if (FilesList.SelectedItem is TransferFile file) _store.Discard(file);
    }

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (!_allowClose)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }
}
